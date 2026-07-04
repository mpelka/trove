import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

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
  const row = db
    .query("SELECT source_path, source_medium, raw_path FROM sessions WHERE id = ?")
    .get(id) as
    | { source_path: string; source_medium: string; raw_path: string | null }
    | undefined;
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
    db.query("INSERT OR REPLACE INTO tombstones (source_path, id, deleted_at) VALUES (?,?,?)").run(
      row.source_path,
      id,
      Date.now(),
    );
    db.query("DELETE FROM messages WHERE session_id = ?").run(id);
    db.query("DELETE FROM session_meta WHERE session_id = ?").run(id);
    db.query("DELETE FROM sessions WHERE id = ?").run(id);
  });
  tx();
  return { ok: true, sourceDeleted };
}

/** Source paths the user has deleted; sync consults this to avoid re-importing them. */
export function tombstonedPaths(db: Database): Set<string> {
  const rows = db.query("SELECT source_path FROM tombstones").all() as { source_path: string }[];
  return new Set(rows.map((r) => r.source_path));
}

/** Stable session ids the user has deleted. Checked in addition to paths so a
 *  moved/renamed source file (e.g. a renamed project dir) can't resurrect a session. */
export function tombstonedIds(db: Database): Set<string> {
  const rows = db.query("SELECT id FROM tombstones WHERE id IS NOT NULL").all() as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}
