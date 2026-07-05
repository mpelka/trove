import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  copyFileSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDb } from "./client.ts";

// The shipped migration folder, resolved relative to this test module.
const shippedMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

// Number of shipped migrations (0000 baseline + every forward migration). openDb applies them
// all on a fresh/untracked DB, so __drizzle_migrations ends with this many rows. Read from the
// journal so this test stays correct as new migrations are added.
const SHIPPED_MIGRATION_COUNT: number = JSON.parse(
  readFileSync(join(shippedMigrations, "meta", "_journal.json"), "utf8"),
).entries.length;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Names of the objects the baseline must materialise on a fresh DB (excludes FTS shadow tables). */
const EXPECTED_OBJECTS = new Set([
  "sessions",
  "messages",
  "session_meta",
  "kv",
  "highlights",
  "summaries",
  "tombstones",
  "messages_fts",
  "messages_ai",
  "messages_ad",
  "messages_au",
  "idx_sessions_agent",
  "idx_sessions_source_path",
  "idx_sessions_updated",
  "idx_messages_session",
  "idx_highlights_session",
]);

describe("schema migrations (issue #19)", () => {
  it("a. fresh DB: baseline creates every object, FTS propagates, baseline is recorded", () => {
    const dir = tmp("trove-migrate-fresh-");
    const db = openDb(join(dir, "fresh.db")); // real file → WAL applies, FTS triggers fire

    const names = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => r.name),
    );
    for (const obj of EXPECTED_OBJECTS) {
      expect(names.has(obj)).toBe(true);
    }

    // FTS content sync: an insert into messages must show up in a MATCH via the AI trigger.
    db.query(
      "INSERT INTO messages (session_id, seq, role, text) VALUES (?,?,?,?)",
    ).run("s1", 0, "user", "peculiar findable needle text");
    const hits = db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?",
      )
      .all("findable");
    expect(hits.length).toBe(1);

    // Every shipped migration is now tracked, so a re-run would be a no-op.
    const migCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(SHIPPED_MIGRATION_COUNT);

    db.close();
  });

  it("b. idempotency: opening the same DB twice applies nothing new and does not error", () => {
    const dir = tmp("trove-migrate-idem-");
    const path = join(dir, "idem.db");

    const db1 = openDb(path);
    const first = db1
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    db1.close();
    expect(first).toBe(SHIPPED_MIGRATION_COUNT);

    // Second open must not throw and must not add another migration row.
    const db2 = openDb(path);
    const second = db2
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    db2.close();
    expect(second).toBe(SHIPPED_MIGRATION_COUNT);
  });

  it("c. existing populated DB: baselining a COPY of the real ~/.trove/trove.db preserves all data", () => {
    // Resolve the DEFAULT store location directly (not via dbPath(), which honours a
    // TROVE_DIR override that other tests may set). NEVER touch the original — copy first.
    const realDb = join(homedir(), ".trove", "trove.db");
    if (!existsSync(realDb)) {
      // Absent in CI etc. — skip gracefully. It IS present in the author's environment.
      console.warn("skip: ~/.trove/trove.db not present, existing-DB baseline case skipped");
      return;
    }

    const dir = tmp("trove-migrate-real-");
    const copy = join(dir, "trove.db");
    copyFileSync(realDb, copy);
    // Copy the WAL/SHM sidecars too, if present, so the snapshot is transactionally consistent.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(realDb + suffix)) copyFileSync(realDb + suffix, copy + suffix);
    }

    // Baseline counts read from the copy BEFORE migrating.
    const pre = new Database(copy);
    const beforeSessions = pre
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sessions")
      .get()!.c;
    const beforeMessages = pre
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages")
      .get()!.c;
    const beforeHighlights = pre
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM highlights")
      .get()!.c;
    const beforeSummaries = pre
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM summaries")
      .get()!.c;
    const beforeMeta = pre
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM session_meta")
      .get()!.c;
    pre.close();

    expect(beforeSessions).toBeGreaterThan(0);
    expect(beforeMessages).toBeGreaterThan(0);

    // The migration must not throw on a DB that already has every object.
    const db = openDb(copy);

    // Row counts unchanged across every table.
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sessions").get()!.c).toBe(
      beforeSessions,
    );
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()!.c).toBe(
      beforeMessages,
    );
    expect(
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM highlights").get()!.c,
    ).toBe(beforeHighlights);
    expect(
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM summaries").get()!.c,
    ).toBe(beforeSummaries);
    expect(
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM session_meta").get()!.c,
    ).toBe(beforeMeta);

    // FTS index still usable — a common token returns hits.
    const ftsHits = db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 5",
      )
      .all("the");
    expect(ftsHits.length).toBeGreaterThan(0);

    // Every shipped migration is now recorded on the previously-untracked store.
    const migCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(SHIPPED_MIGRATION_COUNT);

    db.close();
  });

  it("d. forward migration: a hand-written future migration applies on top of a fully-baselined DB", () => {
    // Build a DB with EVERY shipped migration recorded (0000 + all forward migrations).
    const dir = tmp("trove-migrate-fwd-");
    const path = join(dir, "fwd.db");
    const db = openDb(path);
    db.close();

    // Assemble a temp migrations folder: all shipped migrations verbatim PLUS one new
    // hand-written migration that adds a column. This proves the "survive a future update"
    // promise generically, independent of what the newest shipped migration happens to be.
    const migDir = join(dir, "migrations");
    const metaDir = join(migDir, "meta");
    mkdirSync(metaDir, { recursive: true });

    const shippedJournal = JSON.parse(
      readFileSync(join(shippedMigrations, "meta", "_journal.json"), "utf8"),
    );
    // Copy every shipped .sql + snapshot verbatim so their hashes match the recorded rows
    // (an unchanged shipped migration must NOT re-run).
    for (const entry of shippedJournal.entries as { idx: number; tag: string }[]) {
      copyFileSync(join(shippedMigrations, `${entry.tag}.sql`), join(migDir, `${entry.tag}.sql`));
      const snap = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      copyFileSync(join(shippedMigrations, "meta", snap), join(metaDir, snap));
    }

    const nextIdx = shippedJournal.entries.length;
    const newestWhen = Math.max(...shippedJournal.entries.map((e: { when: number }) => e.when));
    const newTag = `${String(nextIdx).padStart(4, "0")}_add_test_col`;
    // Snapshot for the new migration can mirror the newest shipped snapshot; the runtime
    // migrator ignores snapshots.
    copyFileSync(
      join(shippedMigrations, "meta", `${String(nextIdx - 1).padStart(4, "0")}_snapshot.json`),
      join(metaDir, `${String(nextIdx).padStart(4, "0")}_snapshot.json`),
    );

    // A minimal incremental migration (plain ALTER — no need for IF NOT EXISTS, runs once).
    writeFileSync(
      join(migDir, `${newTag}.sql`),
      "ALTER TABLE `session_meta` ADD `test_col` integer;\n",
    );

    // Journal: every shipped entry verbatim (their `when` values must match what openDb
    // recorded so they're skipped) plus the new one with a strictly-larger `when` so the
    // migrator picks it up.
    writeFileSync(
      join(metaDir, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          ...shippedJournal.entries,
          { idx: nextIdx, version: "6", when: newestWhen + 1, tag: newTag, breakpoints: true },
        ],
      }),
    );

    // Run the migrator against the assembled folder.
    const db2 = new Database(path, { create: true });
    db2.exec("PRAGMA foreign_keys = OFF;");
    migrate(drizzle(db2), { migrationsFolder: migDir });

    // The new column now exists...
    const cols = db2
      .query<{ name: string }, []>("PRAGMA table_info(session_meta)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("test_col");

    // ...and __drizzle_migrations gained the new row (all shipped ones were skipped).
    const migCount = db2
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(SHIPPED_MIGRATION_COUNT + 1);

    db2.close();
  });

  it("e. shipped 0001 applies on a baselined DB and adds messages.tool_calls (issue #20)", () => {
    const dir = tmp("trove-migrate-0001-");
    const path = join(dir, "app.db");

    // First open: baseline (0000) only — 0001 will apply on the SECOND open below, proving it
    // lands cleanly on an already-baselined store (the real ~/.trove/trove.db upgrade path).
    // To isolate 0000, run the migrator against a one-entry folder built from the shipped baseline.
    const baseDir = join(dir, "base");
    const baseMeta = join(baseDir, "meta");
    mkdirSync(baseMeta, { recursive: true });
    const baselineTag = "0000_harsh_norrin_radd";
    copyFileSync(join(shippedMigrations, `${baselineTag}.sql`), join(baseDir, `${baselineTag}.sql`));
    copyFileSync(
      join(shippedMigrations, "meta", "0000_snapshot.json"),
      join(baseMeta, "0000_snapshot.json"),
    );
    const shippedJournal = JSON.parse(
      readFileSync(join(shippedMigrations, "meta", "_journal.json"), "utf8"),
    );
    writeFileSync(
      join(baseMeta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [shippedJournal.entries[0]],
      }),
    );
    const b = new Database(path, { create: true });
    b.exec("PRAGMA foreign_keys = OFF;");
    migrate(drizzle(b), { migrationsFolder: baseDir });
    // Sanity: baseline recorded, tool_calls NOT yet present.
    expect(
      b.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations").get()!.c,
    ).toBe(1);
    const before = b
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((c) => c.name);
    expect(before).not.toContain("tool_calls");
    // A row to prove data survives the ALTER.
    b.query("INSERT INTO messages (session_id, seq, role, text) VALUES (?,?,?,?)").run(
      "s1",
      0,
      "user",
      "hello",
    );
    b.close();

    // Second open: the FULL shipped migrations folder (0000 + 0001). 0000 is skipped
    // (already recorded); the real 0001 applies and adds the column.
    const db = openDb(path);
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("tool_calls");
    // Pre-existing row preserved; its tool_calls defaults to NULL.
    const row = db
      .query<{ text: string; tool_calls: string | null }, []>(
        "SELECT text, tool_calls FROM messages WHERE session_id = 's1'",
      )
      .get()!;
    expect(row.text).toBe("hello");
    expect(row.tool_calls).toBeNull();
    // Both migrations now recorded.
    expect(
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations").get()!.c,
    ).toBe(2);
    db.close();
  });
});
