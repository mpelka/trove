import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, isNotNull } from "drizzle-orm";
import { unlinkSync } from "node:fs";
import { sessions, messages, sessionMeta, highlights, summaries, tombstones } from "./db/drizzle-schema.ts";

export interface DeleteResult {
  ok: boolean;
  sourceDeleted: boolean;
}

/**
 * Delete a session from trove. Always removes our rows + archived raw and writes a
 * **tombstone** (keyed by source_path) so a later sync won't re-import it. With
 * `deleteSource`, also unlinks the original file (file-medium adapters only) — this is
 * the one place trove mutates an agent's store, and only on explicit user request.
 */
export function deleteSession(
  db: Database,
  id: string,
  opts: { deleteSource?: boolean } = {},
): DeleteResult {
  const d = drizzle(db);
  const row = d
    .select({
      source_path: sessions.sourcePath,
      source_medium: sessions.sourceMedium,
      raw_path: sessions.rawPath,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();
  if (!row) return { ok: false, sourceDeleted: false };

  let sourceDeleted = false;
  if (opts.deleteSource && row.source_medium === "file") {
    try {
      unlinkSync(row.source_path);
      sourceDeleted = true;
    } catch {
      // already gone / permission → leave it; the tombstone still keeps it out of trove
    }
  }
  if (row.raw_path) {
    try {
      unlinkSync(row.raw_path);
    } catch {
      /* ignore */
    }
  }

  const tx = db.transaction(() => {
    d.insert(tombstones)
      .values({ sourcePath: row.source_path, id, deletedAt: Date.now() })
      .onConflictDoUpdate({
        target: tombstones.sourcePath,
        set: { id, deletedAt: Date.now() },
      })
      .run();
    d.delete(messages).where(eq(messages.sessionId, id)).run();
    d.delete(sessionMeta).where(eq(sessionMeta.sessionId, id)).run();
    d.delete(highlights).where(eq(highlights.sessionId, id)).run();
    d.delete(summaries).where(eq(summaries.sessionId, id)).run();
    d.delete(sessions).where(eq(sessions.id, id)).run();
  });
  tx();
  return { ok: true, sourceDeleted };
}

/** Source paths the user has deleted; sync consults this to avoid re-importing them. */
export function tombstonedPaths(db: Database): Set<string> {
  const d = drizzle(db);
  const rows = d.select({ source_path: tombstones.sourcePath }).from(tombstones).all();
  return new Set(rows.map((r) => r.source_path));
}

/** Stable session ids the user has deleted. Checked in addition to paths so a
 *  moved/renamed source file (e.g. a renamed project dir) can't resurrect a session. */
export function tombstonedIds(db: Database): Set<string> {
  const d = drizzle(db);
  const rows = d
    .select({ id: tombstones.id })
    .from(tombstones)
    .where(isNotNull(tombstones.id))
    .all();
  return new Set(rows.map((r) => r.id as string));
}
