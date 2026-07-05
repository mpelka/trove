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

// The shipped baseline migration folder, resolved relative to this test module.
const shippedMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

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

    // The baseline is now tracked, so a re-run would be a no-op.
    const migCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(1);

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
    expect(first).toBe(1);

    // Second open must not throw and must not add another migration row.
    const db2 = openDb(path);
    const second = db2
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    db2.close();
    expect(second).toBe(1);
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

    // Baseline is now recorded on the previously-untracked store.
    const migCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(1);

    db.close();
  });

  it("d. forward migration: a hand-written 0001 applies on top of a baselined DB", () => {
    // Build a baselined DB using the shipped migrations.
    const dir = tmp("trove-migrate-fwd-");
    const path = join(dir, "fwd.db");
    const db = openDb(path);
    db.close();

    // Assemble a temp migrations folder: the shipped baseline PLUS a new 0001 that adds a column.
    // This proves the "survive a future update" promise without shipping a real 0001.
    const migDir = join(dir, "migrations");
    const metaDir = join(migDir, "meta");
    mkdirSync(metaDir, { recursive: true });

    // Reuse the shipped baseline file + snapshot verbatim so its hash matches the recorded row
    // (an unchanged baseline must NOT re-run).
    const baselineTag = "0000_harsh_norrin_radd";
    copyFileSync(
      join(shippedMigrations, `${baselineTag}.sql`),
      join(migDir, `${baselineTag}.sql`),
    );
    copyFileSync(
      join(shippedMigrations, "meta", "0000_snapshot.json"),
      join(metaDir, "0000_snapshot.json"),
    );
    // Snapshot for 0001 can mirror the baseline snapshot; the runtime migrator ignores snapshots.
    copyFileSync(
      join(shippedMigrations, "meta", "0000_snapshot.json"),
      join(metaDir, "0001_snapshot.json"),
    );

    // A minimal incremental migration (plain ALTER — no need for IF NOT EXISTS, runs once).
    writeFileSync(
      join(migDir, "0001_add_test_col.sql"),
      "ALTER TABLE `session_meta` ADD `test_col` integer;\n",
    );

    // Journal listing both entries. The baseline entry must keep the SHIPPED `when` value,
    // because that is what openDb recorded in __drizzle_migrations for this DB — the migrator
    // only runs a migration whose folderMillis is greater than the newest recorded one, so
    // 0001 must carry a strictly larger `when` to be picked up (and the baseline, matching,
    // is skipped).
    const shippedJournal = JSON.parse(
      readFileSync(join(shippedMigrations, "meta", "_journal.json"), "utf8"),
    );
    const baselineWhen = shippedJournal.entries[0].when as number;
    writeFileSync(
      join(metaDir, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          { idx: 0, version: "6", when: baselineWhen, tag: baselineTag, breakpoints: true },
          {
            idx: 1,
            version: "6",
            when: baselineWhen + 1,
            tag: "0001_add_test_col",
            breakpoints: true,
          },
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

    // ...and __drizzle_migrations gained the 0001 row (baseline was skipped, so total is 2).
    const migCount = db2
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get()!.c;
    expect(migCount).toBe(2);

    db2.close();
  });
});
