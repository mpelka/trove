import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { deleteSession, tombstonedPaths } from "./curate.ts";
import { setStar } from "./meta.ts";

let dir: string;
let db: Database;

function seedSession(id: string, sourcePath: string, medium: string, rawPath: string | null) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, raw_path,
       content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, "fake", id, sourcePath, medium, rawPath, "h", Date.now());
  db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run(null, id, 0, "user", null, 1, "hello");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-curate-"));
  db = openDb(join(dir, "curate.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("deleteSession", () => {
  it("removes rows and raw archive, writes a tombstone, keeps the source by default", () => {
    const src = join(dir, "source.jsonl");
    const raw = join(dir, "one.raw.gz");
    writeFileSync(src, "raw session\n");
    writeFileSync(raw, "gz");
    seedSession("one", src, "file", raw);
    setStar(db, "one", true);

    const r = deleteSession(db, "one");
    expect(r).toEqual({ ok: true, sourceDeleted: false });

    expect(db.query("SELECT * FROM sessions WHERE id = 'one'").get()).toBeNull();
    expect(db.query("SELECT * FROM messages WHERE session_id = 'one'").get()).toBeNull();
    expect(db.query("SELECT * FROM session_meta WHERE session_id = 'one'").get()).toBeNull();

    const ts = db.query("SELECT * FROM tombstones WHERE source_path = ?").get(src) as any;
    expect(ts.id).toBe("one");
    expect(ts.deleted_at).toBeGreaterThan(0);

    expect(existsSync(raw)).toBe(false); // archived raw removed
    expect(existsSync(src)).toBe(true); // original untouched
    expect(tombstonedPaths(db)).toEqual(new Set([src]));
  });

  it("unlinks the source with deleteSource on a file medium", () => {
    const src = join(dir, "source2.jsonl");
    writeFileSync(src, "bye\n");
    seedSession("two", src, "file", null);

    const r = deleteSession(db, "two", { deleteSource: true });
    expect(r).toEqual({ ok: true, sourceDeleted: true });
    expect(existsSync(src)).toBe(false);
  });

  it("does NOT unlink non-file media even with deleteSource", () => {
    const src = join(dir, "store.db");
    writeFileSync(src, "sqlite-ish\n");
    seedSession("three", src, "sqlite", null);

    const r = deleteSession(db, "three", { deleteSource: true });
    expect(r).toEqual({ ok: true, sourceDeleted: false });
    expect(existsSync(src)).toBe(true);
  });

  it("reports sourceDeleted=false when the source is already gone, but still tombstones", () => {
    const src = join(dir, "already-gone.jsonl");
    seedSession("four", src, "file", null);
    const r = deleteSession(db, "four", { deleteSource: true });
    expect(r).toEqual({ ok: true, sourceDeleted: false });
    expect(tombstonedPaths(db).has(src)).toBe(true);
  });

  it("returns ok:false for a missing id", () => {
    expect(deleteSession(db, "nope")).toEqual({ ok: false, sourceDeleted: false });
    expect(tombstonedPaths(db).size).toBe(0);
  });
});
