import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { archiveDir } from "../paths.ts";
import { setKv } from "../db/client.ts";
import { sessions, messages, sessionMeta, highlights, summaries } from "../db/drizzle-schema.ts";
import { tombstonedPaths, tombstonedIds } from "../curate.ts";
import type { Adapter } from "../adapters/types.ts";

export interface SyncOptions {
  agentIds?: string[];
  keepRaw?: boolean;
  onProgress?: (msg: string) => void;
  /** Re-parse and rewrite every session even when the source is byte-identical. The normal
   *  gates (unchanged size+mtime, then unchanged content hash) key off the SOURCE bytes, not
   *  our parser — so after an adapter change (e.g. #20 adding tool-call detail) a plain sync
   *  won't backfill existing rows. `force` bypasses both gates to reindex the whole store
   *  against the current adapters. */
  force?: boolean;
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  trivial: number;
  gone: number;
  perAgent: Record<string, { sessions: number; messages: number }>;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Rows per bulk message INSERT: 8 bound params each, kept well under SQLite's
 *  ~32k parameter budget (1000 × 8 = 8k). See the chunk loop in sync(). */
const MESSAGE_INSERT_CHUNK = 1000;

/** Incremental, idempotent sync across the given adapters. Safe to run repeatedly. */
export async function sync(
  db: Database,
  agentAdapters: Adapter[],
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    updated: 0,
    unchanged: 0,
    trivial: 0,
    gone: 0,
    perAgent: {},
  };

  const d = drizzle(db);
  const getByPath = db.query(
    "SELECT id, size_bytes, source_mtime, source_gone FROM sessions WHERE source_path = ?",
  );
  const getById = db.query("SELECT source_path, content_hash FROM sessions WHERE id = ?");
  const updateSourceMeta = (path: string, mtime: number | null, size: number | null, id: string) =>
    d
      .update(sessions)
      .set({ sourcePath: path, sourceMtime: mtime, sizeBytes: size, sourceGone: 0 })
      .where(eq(sessions.id, id))
      .run();
  const tombstoned = tombstonedPaths(db); // user-deleted sources — never re-import
  const tombstonedById = tombstonedIds(db); // …even if the file moved to a new path
  const seenIds = new Set<string>(); // guard: two live sources claiming one session id

  for (const adapter of agentAdapters) {
    if (opts.agentIds && !opts.agentIds.includes(adapter.agentId)) continue;
    const bucket = (result.perAgent[adapter.agentId] ??= { sessions: 0, messages: 0 });

    const refs = await adapter.enumerate();
    opts.onProgress?.(`${adapter.agentId}: ${refs.length} candidate session(s)`);
    const seenPaths = new Set<string>();
    // Full set of live source paths this run — lets the collision logic distinguish a
    // MOVED file (old path no longer exists) from a true DUPLICATE (both paths live).
    const livePaths = new Set(refs.map((r) => r.path));

    for (const ref of refs) {
      if (tombstoned.has(ref.path)) continue; // user deleted it — respect that
      seenPaths.add(ref.path);
      const existing = getByPath.get(ref.path) as
        | { id: string; size_bytes: number | null; source_mtime: number | null; source_gone: number }
        | undefined;

      // Fast gate: unchanged size + mtime → skip (CC/gemini files grow on every edit).
      // `force` bypasses it so an adapter change can reindex byte-identical sources.
      if (
        !opts.force &&
        existing &&
        existing.size_bytes === ref.sizeBytes &&
        existing.source_mtime === ref.mtimeMs
      ) {
        seenIds.add(existing.id); // register so a duplicate path can't clobber this id
        if (existing.source_gone) {
          // Source vanished earlier but reappeared unchanged — clear the flag here,
          // since the fast gate skips the upsert that would normally reset it.
          d.update(sessions).set({ sourceGone: 0 }).where(eq(sessions.id, existing.id)).run();
        }
        result.unchanged++;
        continue;
      }

      let parsed;
      try {
        parsed = await adapter.parse(ref);
      } catch (err) {
        opts.onProgress?.(`  ! parse failed for ${ref.path}: ${String(err)}`);
        continue;
      }
      if (!parsed) continue;

      const s = parsed.session;
      const turnCount = s.messages.filter((m) => m.role === "user").length;
      // Filter noise at ingest: skip empty / no-human-turn sessions.
      if (s.messages.length === 0 || turnCount === 0) {
        result.trivial++;
        continue;
      }

      // Display name: the source's own title, else the opening user message (the plan's
      // "first user message" fallback) so every session reads as something, not a uuid.
      const firstUser = s.messages.find((m) => m.role === "user")?.text ?? "";
      const derivedTitle =
        s.sourceTitle ??
        (firstUser ? firstUser.replace(/\s+/g, " ").trim().slice(0, 120) || null : null);

      const id = `${adapter.agentId}:${s.nativeId}`;

      // Respect user deletion even if the source file moved to a new path.
      if (tombstonedById.has(id)) continue;
      // Two live sources claiming the same session id: first wins, warn on the rest —
      // silently letting the second UPSERT clobber the first would lose a session and
      // re-parse both files on every future sync.
      if (seenIds.has(id)) {
        opts.onProgress?.(`  ! duplicate session id ${id} at ${ref.path} — skipped`);
        continue;
      }
      seenIds.add(id);

      // Same source FILE, different id than the row already sitting at this path → the
      // adapter's identity scheme changed (gemini moved from filename-stem to
      // <project>/<stem> once stems turned out to collide across projects). One path is one
      // session, so the old row is stale: re-point the user's sidecar data at the new id and
      // drop it, rather than leaving a duplicate next to the new row forever.
      if (existing && existing.id !== id) {
        const stale = existing.id;
        opts.onProgress?.(`  ~ re-identified ${stale} → ${id}`);
        const migrate = db.transaction(() => {
          d.delete(messages).where(eq(messages.sessionId, stale)).run();
          // Sidecar tables are the user's own work — carry them over. Best-effort: a row
          // may already exist under the new id, in which case the old one is redundant.
          for (const t of [sessionMeta, highlights, summaries]) {
            try {
              d.update(t).set({ sessionId: id }).where(eq(t.sessionId, stale)).run();
            } catch {
              d.delete(t).where(eq(t.sessionId, stale)).run();
            }
          }
          d.delete(sessions).where(eq(sessions.id, stale)).run();
        });
        migrate();
      }

      const existingById = getById.get(id) as
        | { source_path: string; content_hash: string }
        | undefined;
      if (existingById && existingById.source_path !== ref.path) {
        if (livePaths.has(existingById.source_path)) {
          // The id's original source file still exists — this is a second live file
          // claiming the same session. Don't clobber; the original wins.
          opts.onProgress?.(`  ! duplicate session id ${id} at ${ref.path} — skipped`);
          continue;
        }
        // Original path is gone → the file MOVED (e.g. renamed project dir). Same
        // content: update source metadata in place — otherwise the row never matches
        // the fast gate and the file re-parses forever. Changed content falls through
        // to a normal update (which also rewrites source_path via the upsert).
        // `force` falls through to a full rewrite so the parser change lands.
        if (!opts.force && existingById.content_hash === parsed.contentHash) {
          updateSourceMeta(ref.path, ref.mtimeMs, ref.sizeBytes, id);
          seenIds.add(id);
          result.unchanged++;
          continue;
        }
      } else if (!opts.force && existingById && existingById.content_hash === parsed.contentHash) {
        // Same path, same content, but mtime/size drifted (e.g. touch): refresh
        // metadata so the fast gate works next run; no message rewrite.
        updateSourceMeta(ref.path, ref.mtimeMs, ref.sizeBytes, id);
        seenIds.add(id);
        result.unchanged++;
        continue;
      }

      let rawPath: string | null = null;
      if (opts.keepRaw && parsed.raw) {
        rawPath = join(archiveDir(), adapter.agentId, `${sanitize(s.nativeId)}.raw.gz`);
        mkdirSync(dirname(rawPath), { recursive: true });
        await Bun.write(rawPath, Bun.gzipSync(new Uint8Array(parsed.raw)));
      }

      const now = Date.now();
      // Fields written on both insert and conflict-update. imported_at is INTENTIONALLY
      // omitted from the update set (the original row's import time is preserved), and
      // source_gone is reset to 0 on both paths.
      const common = {
        agent: adapter.agentId,
        nativeId: s.nativeId,
        sourcePath: ref.path,
        sourceMedium: ref.medium,
        projectPath: s.projectPath ?? null,
        createdAt: s.createdAt ?? null,
        updatedAt: s.updatedAt ?? null,
        sizeBytes: ref.sizeBytes,
        turnCount,
        messageCount: s.messages.length,
        model: s.model ?? null,
        sourceTitle: derivedTitle,
        kind: s.kind ?? null,
        agentSpecific: s.agentSpecific ? JSON.stringify(s.agentSpecific) : null,
        rawPath,
        contentHash: parsed.contentHash,
        sourceMtime: ref.mtimeMs,
        sourceGone: 0,
      };
      const tx = db.transaction(() => {
        d.delete(messages).where(eq(messages.sessionId, id)).run();
        d.insert(sessions)
          .values({ id, importedAt: now, ...common })
          .onConflictDoUpdate({ target: sessions.id, set: common })
          .run();
        // Insert messages in chunks: each row binds 8 params, and SQLite's bound-
        // parameter budget (~32k) overflows around 4k rows in one statement. Sessions
        // that large are real since the gemini reseed-merge fix — a compaction-heavy
        // session recovers its whole pre-compaction history (~20k messages observed).
        for (let at = 0; at < s.messages.length; at += MESSAGE_INSERT_CHUNK) {
          d.insert(messages)
            .values(
              s.messages.slice(at, at + MESSAGE_INSERT_CHUNK).map((m) => ({
                uid: m.uid ?? null,
                sessionId: id,
                seq: m.seq,
                role: m.role,
                parentUid: m.parentUid ?? null,
                timestamp: m.timestamp ?? null,
                text: m.text,
                // Compact per-tool_use records as JSON; null for non-tool messages (issue #20).
                toolCalls: m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
              })),
            )
            .run();
        }
        d.insert(sessionMeta).values({ sessionId: id }).onConflictDoNothing().run();
      });
      tx();

      if (existingById) result.updated++;
      else result.added++;
      bucket.sessions++;
      bucket.messages += s.messages.length;
    }

    // Upstream vanished → keep the archive, mark the source as gone (never delete our side).
    const live = db
      .query("SELECT id, source_path FROM sessions WHERE agent = ? AND source_gone = 0")
      .all(adapter.agentId) as { id: string; source_path: string }[];
    for (const row of live) {
      if (!seenPaths.has(row.source_path)) {
        d.update(sessions).set({ sourceGone: 1 }).where(eq(sessions.id, row.id)).run();
        result.gone++;
      }
    }
  }

  setKv(db, "last_sync", String(Date.now()));
  return result;
}
