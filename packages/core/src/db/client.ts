import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

/**
 * Open (creating if needed) the trove SQLite store with WAL + a busy_timeout so a
 * CLI process and a running GUI server can share the file (see Gotcha 2 in the plan).
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(SCHEMA_SQL);
  return db;
}

export function getKv(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setKv(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
}
