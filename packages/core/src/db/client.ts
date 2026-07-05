import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { kv } from "./drizzle-schema.ts";

// Migrations live in packages/core/drizzle. Resolve the folder relative to THIS module
// (not process.cwd()) via import.meta.url, so migrations apply identically whether openDb
// is called from the CLI, the API server, or a test — each runs from a different cwd.
// The baseline (0000) is idempotent (all creates use IF NOT EXISTS), so on the user's
// existing populated DB it's a safe no-op that just gets recorded in __drizzle_migrations.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Open (creating if needed) the trove SQLite store with WAL + a busy_timeout so a
 * CLI process and a running GUI server can share the file (see Gotcha 2 in the plan).
 *
 * Schema is brought up to date via tracked drizzle-kit migrations (issue #19) rather than
 * re-exec'ing a full DDL blob: fresh DBs get the whole schema from the baseline, existing
 * DBs are left untouched, and future schema changes ship as incremental migration files.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = OFF;");
  migrate(drizzle(db), { migrationsFolder });
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
