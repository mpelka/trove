import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotAdapter } from "./copilot.ts";
import type { SourceRef } from "./types.ts";

let root: string;
const OLD_ROOT = process.env.TROVE_COPILOT_ROOT;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trove-copilot-"));
  process.env.TROVE_COPILOT_ROOT = root;
  makeStore(join(root, "session-store.db"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (OLD_ROOT === undefined) delete process.env.TROVE_COPILOT_ROOT;
  else process.env.TROVE_COPILOT_ROOT = OLD_ROOT;
});

/** Real v1.0.67 schema (the subset the adapter touches), synthetic content. */
function makeStore(path: string): void {
  const db = new Database(path);
  db.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
      summary TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
  db.run(`CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT,
      timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index)
    )`);
  const ins = db.query(
    "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const insT = db.query(
    "INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?,?,?,?,?)",
  );
  // session A: two turns
  ins.run(
    "sess-aaa",
    "/Users/x/projA",
    null,
    "main",
    "Fix the flaky test",
    "2026-06-01T10:00:00.000Z",
    "2026-06-01T10:00:01.000Z",
  );
  insT.run("sess-aaa", 0, "Fix the flaky test please", "Done, it was a timezone bug.", "2026-06-01T10:05:00.000Z");
  insT.run("sess-aaa", 1, "Now add a regression test", "Added one in foo.test.ts.", "2026-06-01T10:10:00.000Z");
  // session B: one turn, same shared DB
  ins.run(
    "sess-bbb",
    "/Users/x/projB",
    "x/projB",
    "dev",
    null,
    "2026-06-02T09:00:00.000Z",
    "2026-06-02T09:00:01.000Z",
  );
  insT.run("sess-bbb", 0, "Reply with exactly one word: PONG", "PONG", "2026-06-02T09:00:02.000Z");
  // session C: turnless shell (aborted start) — must not be enumerated
  ins.run("sess-empty", "/Users/x/projC", null, null, null, "2026-06-03T08:00:00.000Z", "2026-06-03T08:00:00.000Z");
  db.close();
}

function refFor(sessionId: string, refs: SourceRef[]): SourceRef {
  const r = refs.find((x) => x.dbRowId === sessionId);
  if (!r) throw new Error(`no ref for ${sessionId}`);
  return r;
}

describe("copilotAdapter.enumerate", () => {
  it("yields one ref per session with a synthetic unique path (shared DB)", async () => {
    const refs = await copilotAdapter.enumerate();
    expect(refs.length).toBe(2); // sess-empty excluded
    const dbFile = join(root, "session-store.db");
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual([`${dbFile}::sess-aaa`, `${dbFile}::sess-bbb`]);
    expect(new Set(paths).size).toBe(2);
    for (const r of refs) {
      expect(r.agent).toBe("copilot");
      expect(r.medium).toBe("sqlite");
      expect(r.dbRowId).toBeDefined();
    }
  });

  it("fingerprints per session, not per file: only the changed session moves", async () => {
    const before = await copilotAdapter.enumerate();
    const aBefore = refFor("sess-aaa", before);
    const bBefore = refFor("sess-bbb", before);

    // sess-bbb gains a turn (later timestamp, more bytes)
    const db = new Database(join(root, "session-store.db"));
    db.query(
      "INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?,?,?,?,?)",
    ).run("sess-bbb", 1, "And again", "PONG", "2026-06-02T09:30:00.000Z");
    db.close();

    const after = await copilotAdapter.enumerate();
    const aAfter = refFor("sess-aaa", after);
    const bAfter = refFor("sess-bbb", after);
    // untouched session: identical fingerprint (fast gate will skip it)
    expect(aAfter.sizeBytes).toBe(aBefore.sizeBytes);
    expect(aAfter.mtimeMs).toBe(aBefore.mtimeMs);
    // changed session: both dimensions moved
    expect(bAfter.sizeBytes).toBeGreaterThan(bBefore.sizeBytes);
    expect(bAfter.mtimeMs).toBeGreaterThan(bBefore.mtimeMs);
    expect(bAfter.mtimeMs).toBe(Date.parse("2026-06-02T09:30:00.000Z"));
  });

  it("returns [] when the root or DB is missing", async () => {
    const prev = process.env.TROVE_COPILOT_ROOT;
    try {
      process.env.TROVE_COPILOT_ROOT = join(tmpdir(), "trove-copilot-definitely-missing");
      expect(await copilotAdapter.enumerate()).toEqual([]);
    } finally {
      process.env.TROVE_COPILOT_ROOT = prev;
    }
  });

  it("returns [] for a corrupt DB file", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "trove-copilot-bad-"));
    const prev = process.env.TROVE_COPILOT_ROOT;
    try {
      process.env.TROVE_COPILOT_ROOT = badRoot;
      writeFileSync(join(badRoot, "session-store.db"), "this is not sqlite");
      expect(await copilotAdapter.enumerate()).toEqual([]);
    } finally {
      process.env.TROVE_COPILOT_ROOT = prev;
      rmSync(badRoot, { recursive: true, force: true });
    }
  });
});

describe("copilotAdapter.parse", () => {
  it("maps turns to alternating user/assistant messages with timestamps", async () => {
    const refs = await copilotAdapter.enumerate();
    const parsed = await copilotAdapter.parse(refFor("sess-aaa", refs));
    expect(parsed).not.toBeNull();
    const s = parsed!.session;

    expect(s.nativeId).toBe("sess-aaa");
    expect(s.projectPath).toBe("/Users/x/projA");
    expect(s.sourceTitle).toBe("Fix the flaky test");
    expect(s.agentSpecific?.branch).toBe("main");

    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(s.messages.map((m) => m.uid)).toEqual([
      "t0-user",
      "t0-assistant",
      "t1-user",
      "t1-assistant",
    ]);
    expect(s.messages[0]!.text).toBe("Fix the flaky test please");
    expect(s.messages[1]!.text).toBe("Done, it was a timezone bug.");
    expect(s.messages[0]!.timestamp).toBe(Date.parse("2026-06-01T10:05:00.000Z"));
    expect(s.messages[2]!.timestamp).toBe(Date.parse("2026-06-01T10:10:00.000Z"));
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);

    // createdAt from the session row; updatedAt covers the last turn
    expect(s.createdAt).toBe(Date.parse("2026-06-01T10:00:00.000Z"));
    expect(s.updatedAt).toBe(Date.parse("2026-06-01T10:10:00.000Z"));

    // raw is a faithful JSON serialization of the raw rows
    const raw = JSON.parse(new TextDecoder().decode(parsed!.raw!));
    expect(raw.session.id).toBe("sess-aaa");
    expect(raw.turns.length).toBe(2);
    expect(parsed!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps two sessions in one shared DB fully independent", async () => {
    const refs = await copilotAdapter.enumerate();
    const a = await copilotAdapter.parse(refFor("sess-aaa", refs));
    const b = await copilotAdapter.parse(refFor("sess-bbb", refs));
    expect(a!.session.nativeId).toBe("sess-aaa");
    expect(b!.session.nativeId).toBe("sess-bbb");
    expect(b!.session.projectPath).toBe("/Users/x/projB");
    expect(a!.contentHash).not.toBe(b!.contentHash);
    const aText = a!.session.messages.map((m) => m.text).join("\n");
    expect(aText).not.toContain("PONG"); // no cross-session bleed
  });

  it("re-parsing an unchanged session yields the same contentHash (deterministic)", async () => {
    const refs = await copilotAdapter.enumerate();
    const once = await copilotAdapter.parse(refFor("sess-aaa", refs));
    const twice = await copilotAdapter.parse(refFor("sess-aaa", refs));
    expect(once!.contentHash).toBe(twice!.contentHash);
  });

  it("returns null for an unknown session id or corrupt DB", async () => {
    const dbFile = join(root, "session-store.db");
    const ghost: SourceRef = {
      agent: "copilot",
      medium: "sqlite",
      path: `${dbFile}::no-such-session`,
      dbRowId: "no-such-session",
      sizeBytes: 0,
      mtimeMs: 0,
    };
    expect(await copilotAdapter.parse(ghost)).toBeNull();

    const badDir = mkdtempSync(join(tmpdir(), "trove-copilot-badparse-"));
    try {
      const bad = join(badDir, "session-store.db");
      writeFileSync(bad, "garbage");
      const badRef: SourceRef = {
        agent: "copilot",
        medium: "sqlite",
        path: `${bad}::sess-aaa`,
        dbRowId: "sess-aaa",
        sizeBytes: 0,
        mtimeMs: 0,
      };
      expect(await copilotAdapter.parse(badRef)).toBeNull();
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

describe("copilotAdapter.buildResumeCommand", () => {
  it("cds into the project and resumes by session id", () => {
    expect(
      copilotAdapter.buildResumeCommand!({ nativeId: "sess-aaa", projectPath: "/Users/x/projA" }),
    ).toBe("cd '/Users/x/projA' && copilot --resume=sess-aaa");
    expect(copilotAdapter.buildResumeCommand!({ nativeId: "sess-aaa" })).toBe(
      "copilot --resume=sess-aaa",
    );
    expect(copilotAdapter.buildResumeCommand!({ nativeId: "" })).toBeNull();
  });
});
