import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { archiveDir } from "../paths.ts";
import { setKv } from "../db/client.ts";
import { tombstonedPaths } from "../curate.ts";
import type { Adapter } from "../adapters/types.ts";

export interface SyncOptions {
  agentIds?: string[];
  keepRaw?: boolean;
  onProgress?: (msg: string) => void;
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  trivial: number;
  gone: number;
  perAgent: Record<string, { sessions: number; messages: number }>;
}

const INSERT_SESSION_SQL = `
INSERT INTO sessions
  (id, agent, native_id, source_path, source_medium, project_path, created_at, updated_at,
   size_bytes, turn_count, message_count, model, source_title, kind, agent_specific, raw_path,
   content_hash, source_mtime, imported_at, source_gone)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
ON CONFLICT(id) DO UPDATE SET
  agent=excluded.agent, native_id=excluded.native_id, source_path=excluded.source_path,
  source_medium=excluded.source_medium, project_path=excluded.project_path,
  created_at=excluded.created_at, updated_at=excluded.updated_at, size_bytes=excluded.size_bytes,
  turn_count=excluded.turn_count, message_count=excluded.message_count, model=excluded.model,
  source_title=excluded.source_title, kind=excluded.kind, agent_specific=excluded.agent_specific,
  raw_path=excluded.raw_path, content_hash=excluded.content_hash, source_mtime=excluded.source_mtime,
  source_gone=0`;

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

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

  const getByPath = db.query(
    "SELECT id, size_bytes, source_mtime FROM sessions WHERE source_path = ?",
  );
  const insertSession = db.query(INSERT_SESSION_SQL);
  const deleteMessages = db.query("DELETE FROM messages WHERE session_id = ?");
  const insertMessage = db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  );
  const ensureMeta = db.query("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)");
  const tombstoned = tombstonedPaths(db); // user-deleted sources — never re-import

  for (const adapter of agentAdapters) {
    if (opts.agentIds && !opts.agentIds.includes(adapter.agentId)) continue;
    const bucket = (result.perAgent[adapter.agentId] ??= { sessions: 0, messages: 0 });

    const refs = await adapter.enumerate();
    opts.onProgress?.(`${adapter.agentId}: ${refs.length} candidate session(s)`);
    const seenPaths = new Set<string>();

    for (const ref of refs) {
      if (tombstoned.has(ref.path)) continue; // user deleted it — respect that
      seenPaths.add(ref.path);
      const existing = getByPath.get(ref.path) as
        | { id: string; size_bytes: number | null; source_mtime: number | null }
        | undefined;

      // Fast gate: unchanged size + mtime → skip (CC/gemini files grow on every edit).
      if (
        existing &&
        existing.size_bytes === ref.sizeBytes &&
        existing.source_mtime === ref.mtimeMs
      ) {
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

      let rawPath: string | null = null;
      if (opts.keepRaw && parsed.raw) {
        rawPath = join(archiveDir(), adapter.agentId, `${sanitize(s.nativeId)}.raw.gz`);
        mkdirSync(dirname(rawPath), { recursive: true });
        await Bun.write(rawPath, Bun.gzipSync(new Uint8Array(parsed.raw)));
      }

      const now = Date.now();
      const tx = db.transaction(() => {
        deleteMessages.run(id);
        insertSession.run(
          id,
          adapter.agentId,
          s.nativeId,
          ref.path,
          ref.medium,
          s.projectPath ?? null,
          s.createdAt ?? null,
          s.updatedAt ?? null,
          ref.sizeBytes,
          turnCount,
          s.messages.length,
          s.model ?? null,
          derivedTitle,
          s.kind ?? null,
          s.agentSpecific ? JSON.stringify(s.agentSpecific) : null,
          rawPath,
          parsed.contentHash,
          ref.mtimeMs,
          now,
        );
        for (const m of s.messages) {
          insertMessage.run(
            m.uid ?? null,
            id,
            m.seq,
            m.role,
            m.parentUid ?? null,
            m.timestamp ?? null,
            m.text,
          );
        }
        ensureMeta.run(id);
      });
      tx();

      if (existing) result.updated++;
      else result.added++;
      bucket.sessions++;
      bucket.messages += s.messages.length;
    }

    // Upstream vanished → keep the archive, mark the source as gone (never delete our side).
    const live = db
      .query("SELECT id, source_path FROM sessions WHERE agent = ? AND source_gone = 0")
      .all(adapter.agentId) as { id: string; source_path: string }[];
    const markGone = db.query("UPDATE sessions SET source_gone = 1 WHERE id = ?");
    for (const row of live) {
      if (!seenPaths.has(row.source_path)) {
        markGone.run(row.id);
        result.gone++;
      }
    }
  }

  setKv(db, "last_sync", String(Date.now()));
  return result;
}
