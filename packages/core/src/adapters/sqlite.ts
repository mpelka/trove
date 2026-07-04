import { Database } from "bun:sqlite";

/**
 * Open a SQLite database strictly read-only, never writing to the source.
 *
 * Two-step dance because of WAL quirks:
 *  1. A plain `readonly` open works while the owning CLI is running (the -shm/-wal
 *     sidecars exist), but fails with SQLITE_CANTOPEN on a *quiescent* WAL database
 *     whose sidecars were cleaned up — a read-only connection may not create them.
 *  2. Fall back to `file:…?immutable=1`, which skips locking/WAL entirely. Safe
 *     precisely in the quiescent case (nothing is writing); never reached while the
 *     owner holds the sidecars, since step 1 succeeds then.
 *
 * bun:sqlite opens lazily, so a probe query is required to surface open errors
 * (`SELECT 1` is answered without touching the file — probe sqlite_master instead).
 * Returns null when the database can't be opened or read (locked, corrupt, gone) —
 * callers fail soft.
 */
export function openReadonlyDb(path: string): Database | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.query("SELECT COUNT(*) FROM sqlite_master").get();
      return db;
    } catch {
      try {
        db.close();
      } catch {}
    }
  } catch {}
  try {
    const db = new Database(`file://${path}?immutable=1`, { readonly: true });
    db.query("SELECT COUNT(*) FROM sqlite_master").get();
    return db;
  } catch {
    return null;
  }
}
