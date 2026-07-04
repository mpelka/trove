// Regression tests for sync identity-integrity fixes: duplicate-nativeId collisions,
// moved source files (no churn, no data loss), and tombstone-by-id (rename-proof deletes).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client.ts";
import { sync } from "./sync.ts";
import { deleteSession } from "../curate.ts";
import type { Adapter, SourceRef, ParseResult } from "../adapters/types.ts";

interface FakeSource {
  path: string;
  nativeId: string;
  text: string; // message text; also drives contentHash
  mtimeMs?: number;
}

/** Minimal in-memory adapter: one user+assistant message per source. */
function fakeAdapter(sources: () => FakeSource[]): Adapter & { parseCalls: string[] } {
  const parseCalls: string[] = [];
  return {
    agentId: "fake",
    parseCalls,
    discoverLocations: () => [],
    async enumerate(): Promise<SourceRef[]> {
      return sources().map((s) => ({
        agent: "fake",
        medium: "file" as const,
        path: s.path,
        sizeBytes: s.text.length,
        mtimeMs: s.mtimeMs ?? 1000,
      }));
    },
    async parse(ref: SourceRef): Promise<ParseResult | null> {
      parseCalls.push(ref.path);
      const src = sources().find((s) => s.path === ref.path)!;
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(src.text);
      return {
        session: {
          nativeId: src.nativeId,
          projectPath: "/tmp/proj",
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { seq: 0, role: "user", text: src.text, uid: null, parentUid: null, timestamp: 1 },
            { seq: 1, role: "assistant", text: "ok", uid: null, parentUid: null, timestamp: 2 },
          ],
        },
        contentHash: hasher.digest("hex"),
      };
    },
  };
}

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-sync-integrity-"));
  process.env.TROVE_DIR = dir;
  db = openDb(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  delete process.env.TROVE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const count = (sql: string) => (db.query(sql).get() as { n: number }).n;

describe("duplicate nativeId across two source paths", () => {
  it("first wins, second is skipped with a warning — no clobber, no churn", async () => {
    const srcs: FakeSource[] = [
      { path: "/a/one.json", nativeId: "dup", text: "first content" },
      { path: "/b/two.json", nativeId: "dup", text: "second content" },
    ];
    const adapter = fakeAdapter(() => srcs);
    const warnings: string[] = [];
    const r1 = await sync(db, [adapter], { onProgress: (m) => warnings.push(m) });

    expect(r1.added).toBe(1); // not double-counted
    expect(count("SELECT COUNT(*) n FROM sessions")).toBe(1);
    expect(warnings.some((w) => w.includes("duplicate session id"))).toBe(true);
    // first enumeration wins
    const row = db.query("SELECT source_path FROM sessions WHERE id = 'fake:dup'").get() as any;
    expect(row.source_path).toBe("/a/one.json");

    // second sync: the winner is unchanged via the fast gate; the loser is skipped
    // again — crucially it does NOT count as added/updated forever
    const r2 = await sync(db, [adapter], {});
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(1);
  });
});

describe("moved source file (same content, new path)", () => {
  it("updates source metadata in place — session survives, no message rewrite loop", async () => {
    const srcs: FakeSource[] = [{ path: "/old/s.json", nativeId: "mv", text: "hello world" }];
    const adapter = fakeAdapter(() => srcs);
    await sync(db, [adapter], {});
    expect(count("SELECT COUNT(*) n FROM sessions WHERE source_gone = 0")).toBe(1);

    srcs[0] = { ...srcs[0], path: "/new/s.json" }; // renamed project dir
    const r2 = await sync(db, [adapter], {});
    expect(r2.unchanged).toBe(1);
    expect(r2.added).toBe(0);
    expect(r2.gone).toBe(0); // not marked gone — it's the same session at a new path
    const row = db.query("SELECT source_path FROM sessions WHERE id = 'fake:mv'").get() as any;
    expect(row.source_path).toBe("/new/s.json");

    // third sync settles via the fast gate (no re-parse churn)
    adapter.parseCalls.length = 0;
    const r3 = await sync(db, [adapter], {});
    expect(r3.unchanged).toBe(1);
    expect(adapter.parseCalls).toEqual([]);
  });
});

describe("tombstone by id", () => {
  it("a deleted session stays deleted even after its source file moves", async () => {
    const srcs: FakeSource[] = [{ path: "/p1/s.json", nativeId: "del", text: "secret stuff" }];
    const adapter = fakeAdapter(() => srcs);
    await sync(db, [adapter], {});
    expect(deleteSession(db, "fake:del").ok).toBe(true);

    srcs[0] = { ...srcs[0], path: "/p2/s.json" }; // move → path-tombstone alone would miss it
    await sync(db, [adapter], {});
    expect(count("SELECT COUNT(*) n FROM sessions")).toBe(0);
  });
});
