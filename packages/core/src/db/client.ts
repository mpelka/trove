import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { SCHEMA_SQL } from "./schema.ts";
import { kv } from "./drizzle-schema.ts";

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
  const d = drizzle(db);
  const row = d
    .select({ value: kv.value })
    .from(kv)
    .where(eq(kv.key, key))
    .get();
  return row?.value ?? null;
}

export function setKv(db: Database, key: string, value: string): void {
  const d = drizzle(db);
  d.insert(kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: kv.key, set: { value } })
    .run();
}
