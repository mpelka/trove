import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the trove SQLite store (issue #19).
 *
 * `drizzle-kit generate` diffs ./src/db/drizzle-schema.ts against the last snapshot in
 * ./drizzle/meta and emits an incremental migration. It only models the regular tables it
 * can see; the FTS5 virtual table `messages_fts` and its 3 triggers (messages_ai/ad/au)
 * are NOT expressible in drizzle-schema.ts and are managed MANUALLY inside the migrations
 * (see drizzle/0000_*.sql). generate will never touch those objects — leave them alone.
 *
 * No `dbCredentials` here: we never point drizzle-kit at a live database. Generation is a
 * pure schema→SQL diff, and migrations are applied at runtime by openDb() via drizzle-orm's
 * migrate() (drizzle-orm/bun-sqlite/migrator).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/drizzle-schema.ts",
  out: "./drizzle",
});
