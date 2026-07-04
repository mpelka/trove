import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client.ts";
import { sync } from "./sync.ts";
import { deleteSession } from "../curate.ts";
import { setStar, setName } from "../meta.ts";
import { archiveDir } from "../paths.ts";
import type { Adapter, NormalizedMessage, ParseResult, SourceRef } from "../adapters/types.ts";

// ── fake in-repo adapter: records out of in-memory fixtures ────────────────
interface FakeSource {
  ref: SourceRef;
  parsed: ParseResult | null;
}

function makeFake(agentId = "fake"): {
  adapter: Adapter;
  sources: FakeSource[];
  parseCalls: () => number;
} {
  const sources: FakeSource[] = [];
  let parseCalls = 0;
  const adapter: Adapter = {
    agentId,
    discoverLocations: () => ["/nowhere"],
    enumerate: async () => sources.map((s) => s.ref),
    parse: async (ref) => {
      parseCalls++;
      return sources.find((s) => s.ref.path === ref.path)?.parsed ?? null;
    },
  };
  return { adapter, sources, parseCalls: () => parseCalls };
}

function msg(seq: number, role: NormalizedMessage["role"], text: string): NormalizedMessage {
  return { uid: `uid-${seq}`, seq, role, parentUid: null, timestamp: 1000 + seq, text };
}

function source(
  agentId: string,
  nativeId: string,
  messages: NormalizedMessage[],
  opts: { sourceTitle?: string | null; mtimeMs?: number; sizeBytes?: number; raw?: string } = {},
): FakeSource {
  const raw = new TextEncoder().encode(opts.raw ?? `raw-of-${nativeId}`);
  return {
    ref: {
      agent: agentId,
      medium: "file",
      path: `/fake/${nativeId}.jsonl`,
      sizeBytes: opts.sizeBytes ?? raw.length,
      mtimeMs: opts.mtimeMs ?? 111,
    },
    parsed: {
      session: {
        nativeId,
        projectPath: "/proj/x",
        createdAt: 1000,
        updatedAt: 2000,
        model: "test-model",
        sourceTitle: opts.sourceTitle ?? null,
        kind: null,
        agentSpecific: { fixture: true },
        messages,
      },
      contentHash: `hash-${nativeId}-${opts.mtimeMs ?? 111}`,
      raw,
    },
  };
}

let dir: string;
let db: Database;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-sync-"));
  process.env.TROVE_DIR = dir; // keepRaw archives + kv stay inside the temp dir
  db = openDb(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

const sessionRow = (id: string) =>
  db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
const messageTexts = (id: string) =>
  (db.query("SELECT text FROM messages WHERE session_id = ? ORDER BY seq").all(id) as any[]).map(
    (r) => r.text,
  );

describe("sync", () => {
  it("fresh sync adds sessions, messages and meta, deriving title from the first user message", async () => {
    const { adapter, sources } = makeFake();
    sources.push(
      source("fake", "one", [
        msg(0, "tool", "[used: Bash]"),
        msg(1, "user", "  Fix   the\n\nlogin bug  "),
        msg(2, "assistant", "On it."),
      ]),
    );
    const r = await sync(db, [adapter]);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.perAgent.fake).toEqual({ sessions: 1, messages: 3 });

    const row = sessionRow("fake:one");
    expect(row).toBeDefined();
    expect(row.native_id).toBe("one");
    expect(row.turn_count).toBe(1); // only user turns count
    expect(row.message_count).toBe(3);
    expect(row.source_title).toBe("Fix the login bug"); // whitespace collapsed
    expect(row.source_gone).toBe(0);
    expect(row.raw_path).toBeNull(); // keepRaw off
    expect(JSON.parse(row.agent_specific)).toEqual({ fixture: true });

    // message text is stored verbatim (adapters trim; sync does not)
    expect(messageTexts("fake:one")).toEqual(["[used: Bash]", "  Fix   the\n\nlogin bug  ", "On it."]);
    const meta = db.query("SELECT * FROM session_meta WHERE session_id = ?").get("fake:one");
    expect(meta).toBeDefined();
  });

  it("prefers the source's own title and caps derived titles at 120 chars", async () => {
    const { adapter, sources } = makeFake();
    sources.push(
      source("fake", "titled", [msg(0, "user", "hello")], { sourceTitle: "Native Title" }),
      source("fake", "long", [msg(0, "user", "x".repeat(300))]),
    );
    await sync(db, [adapter]);
    expect(sessionRow("fake:titled").source_title).toBe("Native Title");
    expect(sessionRow("fake:long").source_title).toHaveLength(120);
  });

  it("skips unchanged sources (same size + mtime) without re-parsing", async () => {
    const { adapter, sources, parseCalls } = makeFake();
    sources.push(source("fake", "one", [msg(0, "user", "hi")]));
    await sync(db, [adapter]);
    const before = parseCalls();
    const r2 = await sync(db, [adapter]);
    expect(r2.unchanged).toBe(1);
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(parseCalls()).toBe(before); // fast gate: parse not called again
  });

  it("replaces messages on change but preserves session_meta (star + name survive re-sync)", async () => {
    const { adapter, sources } = makeFake();
    sources.push(source("fake", "one", [msg(0, "user", "original question")]));
    await sync(db, [adapter]);

    setStar(db, "fake:one", true);
    setName(db, "fake:one", "my precious session");

    sources[0] = source(
      "fake",
      "one",
      [msg(0, "user", "original question"), msg(1, "assistant", "new answer")],
      { mtimeMs: 999, sizeBytes: 12345 },
    );
    const r = await sync(db, [adapter]);
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);

    expect(messageTexts("fake:one")).toEqual(["original question", "new answer"]);
    expect(sessionRow("fake:one").message_count).toBe(2);
    const meta = db
      .query("SELECT starred, custom_name FROM session_meta WHERE session_id = ?")
      .get("fake:one") as any;
    expect(meta.starred).toBe(1);
    expect(meta.custom_name).toBe("my precious session");
    // no duplicate message rows
    const n = (db.query("SELECT COUNT(*) n FROM messages WHERE session_id = ?").get("fake:one") as any).n;
    expect(n).toBe(2);
  });

  it("skips empty and no-user-turn sessions as trivial", async () => {
    const { adapter, sources } = makeFake();
    sources.push(
      source("fake", "empty", []),
      source("fake", "botsonly", [msg(0, "assistant", "hello?"), msg(1, "tool", "[used: Read]")]),
    );
    const r = await sync(db, [adapter]);
    expect(r.trivial).toBe(2);
    expect(r.added).toBe(0);
    expect(sessionRow("fake:empty")).toBeNull();
    expect(sessionRow("fake:botsonly")).toBeNull();
  });

  it("marks vanished sources as gone but keeps the archived rows", async () => {
    const { adapter, sources } = makeFake();
    sources.push(source("fake", "one", [msg(0, "user", "hi")]));
    await sync(db, [adapter]);

    sources.length = 0; // upstream deleted the file
    const r = await sync(db, [adapter]);
    expect(r.gone).toBe(1);
    const row = sessionRow("fake:one");
    expect(row.source_gone).toBe(1);
    expect(messageTexts("fake:one")).toEqual(["hi"]); // messages kept

    // a re-appearing source flips it back
    sources.push(source("fake", "one", [msg(0, "user", "hi")], { mtimeMs: 222 }));
    await sync(db, [adapter]);
    expect(sessionRow("fake:one").source_gone).toBe(0);
  });

  it("never re-imports a tombstoned path", async () => {
    const { adapter, sources } = makeFake();
    sources.push(source("fake", "one", [msg(0, "user", "hi")]));
    await sync(db, [adapter]);

    const del = deleteSession(db, "fake:one");
    expect(del.ok).toBe(true);

    const r = await sync(db, [adapter]);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(sessionRow("fake:one")).toBeNull();
  });

  it("keepRaw writes a gzipped raw archive and records raw_path", async () => {
    const { adapter, sources } = makeFake();
    sources.push(source("fake", "one", [msg(0, "user", "hi")], { raw: "the raw bytes" }));
    await sync(db, [adapter], { keepRaw: true });

    const row = sessionRow("fake:one");
    expect(row.raw_path).toBe(join(archiveDir(), "fake", "one.raw.gz"));
    expect(row.raw_path.startsWith(dir)).toBe(true); // hermetic: inside TROVE_DIR
    expect(existsSync(row.raw_path)).toBe(true);
    const inflated = Bun.gunzipSync(new Uint8Array(await Bun.file(row.raw_path).arrayBuffer()));
    expect(new TextDecoder().decode(inflated)).toBe("the raw bytes");
  });

  it("honours the agentIds filter and records last_sync", async () => {
    const a = makeFake("agent-a");
    const b = makeFake("agent-b");
    a.sources.push(source("agent-a", "s1", [msg(0, "user", "a")]));
    b.sources.push(source("agent-b", "s2", [msg(0, "user", "b")]));
    const r = await sync(db, [a.adapter, b.adapter], { agentIds: ["agent-a"] });
    expect(r.added).toBe(1);
    expect(sessionRow("agent-a:s1")).toBeDefined();
    expect(sessionRow("agent-b:s2")).toBeNull();
    const last = db.query("SELECT value FROM kv WHERE key = 'last_sync'").get() as any;
    expect(Number(last.value)).toBeGreaterThan(0);
  });
});
