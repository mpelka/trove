import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, setKv } from "./db/client.ts";
import { listSessions, status, getSessionDetail, lookupId } from "./queries.ts";
import { setStar, setHidden, addTags, setName } from "./meta.ts";

let dir: string;
let db: Database;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

const CC_UUID = "7de4a1b2-0f0f-4e4e-8a8a-123456789abc";
const CC2_UUID = "7de4a1ff-1111-4e4e-8a8a-aaaaaaaaaaaa"; // shares "7de4a1" with CC_UUID
const GEM_NATIVE = "session-2025-06-01T10-00-cafe1234";

function seedSession(
  id: string,
  agent: string,
  nativeId: string,
  opts: {
    project?: string | null;
    title?: string | null;
    createdAt?: number;
    updatedAt?: number;
    turns?: number;
    gone?: number;
  } = {},
) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, project_path,
       created_at, updated_at, size_bytes, turn_count, message_count, model, source_title,
       content_hash, imported_at, source_gone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    agent,
    nativeId,
    `/src/${nativeId}`,
    "file",
    opts.project ?? null,
    opts.createdAt ?? 1000,
    opts.updatedAt ?? 2000,
    64,
    opts.turns ?? 1,
    2,
    "m1",
    opts.title ?? null,
    "h",
    Date.now(),
    opts.gone ?? 0,
  );
}

// Explicit 4-digit rowids: lookupId ignores queries under 4 chars, so tiny
// autoincrement ids (1, 2, …) are not addressable by number.
let nextMsgId = 4321;
function seedMessage(sessionId: string, seq: number, uid: string | null, text: string) {
  db.query(
    "INSERT INTO messages (id, uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?,?)",
  ).run(nextMsgId++, uid, sessionId, seq, seq % 2 ? "assistant" : "user", null, 100 + seq, text);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-queries-"));
  process.env.TROVE_DIR = dir; // status() reads dbPath() → keep it inside the temp dir
  db = openDb(join(dir, "trove.db")); // matches dbPath() so dbSizeBytes resolves

  seedSession(`claude-code:${CC_UUID}`, "claude-code", CC_UUID, {
    project: "/Users/x/alpha",
    title: "Alpha work",
    createdAt: 100,
    updatedAt: 5000,
    turns: 3,
  });
  seedSession(`claude-code:${CC2_UUID}`, "claude-code", CC2_UUID, {
    project: "/Users/x/beta",
    title: "Beta work",
    createdAt: 300,
    updatedAt: 4000,
    turns: 7,
    gone: 1,
  });
  seedSession(`gemini-cli:${GEM_NATIVE}`, "gemini-cli", GEM_NATIVE, {
    project: "/Users/x/alpha",
    title: "Gamma work",
    createdAt: 200,
    updatedAt: 6000,
    turns: 5,
  });

  seedMessage(`claude-code:${CC_UUID}`, 0, "msg-uid-one", "hello there");
  seedMessage(`claude-code:${CC_UUID}`, 1, "msg-uid-two", "general kenobi");
  seedMessage(`gemini-cli:${GEM_NATIVE}`, 0, null, "gemini says hi");

  setStar(db, `claude-code:${CC_UUID}`, true);
  addTags(db, `claude-code:${CC_UUID}`, ["work"]);
  setName(db, `gemini-cli:${GEM_NATIVE}`, "Renamed gamma");
  setKv(db, "last_sync", "1234567");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("listSessions", () => {
  it("defaults to updated-desc, hidden excluded, all agents", () => {
    const list = listSessions(db);
    expect(list.map((s) => s.id)).toEqual([
      `gemini-cli:${GEM_NATIVE}`,
      `claude-code:${CC_UUID}`,
      `claude-code:${CC2_UUID}`,
    ]);
    const gamma = list[0];
    expect(gamma.name).toBe("Renamed gamma"); // custom_name wins over source_title
    expect(gamma.starred).toBe(false);
    expect(list[1].name).toBe("Alpha work");
    expect(list[1].starred).toBe(true);
    expect(list[1].tags).toEqual(["work"]);
    expect(list[2].sourceGone).toBe(true);
  });

  it("filters by agent, star, tag and project", () => {
    expect(listSessions(db, { agent: "gemini-cli" }).map((s) => s.id)).toEqual([
      `gemini-cli:${GEM_NATIVE}`,
    ]);
    expect(listSessions(db, { star: true }).map((s) => s.id)).toEqual([`claude-code:${CC_UUID}`]);
    expect(listSessions(db, { tag: "work" }).map((s) => s.id)).toEqual([`claude-code:${CC_UUID}`]);
    expect(listSessions(db, { tag: "nope" })).toEqual([]);
    expect(listSessions(db, { project: "beta" }).map((s) => s.id)).toEqual([
      `claude-code:${CC2_UUID}`,
    ]);
  });

  it("hides hidden sessions unless includeHidden", () => {
    setHidden(db, `claude-code:${CC2_UUID}`, true);
    try {
      expect(listSessions(db).map((s) => s.id)).not.toContain(`claude-code:${CC2_UUID}`);
      expect(listSessions(db, { includeHidden: true }).map((s) => s.id)).toContain(
        `claude-code:${CC2_UUID}`,
      );
    } finally {
      setHidden(db, `claude-code:${CC2_UUID}`, false);
    }
  });

  it("supports created / name / turns sorts and limit", () => {
    expect(listSessions(db, { sort: "created" })[0].id).toBe(`claude-code:${CC2_UUID}`); // created 300
    expect(listSessions(db, { sort: "turns" })[0].turnCount).toBe(7);
    const byName = listSessions(db, { sort: "name" }).map((s) => s.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(listSessions(db, { limit: 2 }).length).toBe(2);
  });
});

describe("status", () => {
  it("reports counts, per-agent stats, last sync and db size", () => {
    const st = status(db);
    expect(st.totalSessions).toBe(3);
    expect(st.totalMessages).toBe(3);
    expect(st.starred).toBe(1);
    expect(st.gone).toBe(1);
    const cc = st.perAgent.find((a) => a.agent === "claude-code")!;
    expect(cc.sessions).toBe(2);
    expect(cc.messages).toBe(4); // sum of message_count (2 each)
    expect(st.lastSync).toBe(1234567);
    expect(st.dbSizeBytes).toBeGreaterThan(0);
  });
});

describe("getSessionDetail", () => {
  it("returns the session with meta and seq-ordered messages", () => {
    const d = getSessionDetail(db, `claude-code:${CC_UUID}`)!;
    expect(d.session.nativeId).toBe(CC_UUID);
    expect(d.session.name).toBe("Alpha work");
    expect(d.session.customName).toBeNull();
    expect(d.session.starred).toBe(true);
    expect(d.session.tags).toEqual(["work"]);
    expect(d.messages.map((m) => m.text)).toEqual(["hello there", "general kenobi"]);
  });

  it("returns null for an unknown id", () => {
    expect(getSessionDetail(db, "nope:missing")).toBeNull();
  });
});

describe("lookupId", () => {
  it("resolves a numeric message id", () => {
    const mid = (db.query("SELECT id FROM messages WHERE uid = 'msg-uid-one'").get() as any).id;
    expect(lookupId(db, String(mid))).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: mid,
      kind: "message",
    });
    expect(lookupId(db, "999999")).toBeNull();
  });

  it("resolves a full namespaced session id", () => {
    expect(lookupId(db, `claude-code:${CC_UUID}`)).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: null,
      kind: "session",
    });
  });

  it("resolves cc· / gem: short-id prefixes", () => {
    expect(lookupId(db, "cc·7de4a1b2")).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: null,
      kind: "session",
    });
    expect(lookupId(db, `gem:${GEM_NATIVE.slice(0, 12)}`)).toEqual({
      sessionId: `gemini-cli:${GEM_NATIVE}`,
      messageId: null,
      kind: "session",
    });
    // agent-prefixed with a colon
    expect(lookupId(db, `claude-code:${CC_UUID.slice(0, 10)}`)).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: null,
      kind: "session",
    });
  });

  it("resolves a message uid to a message jump", () => {
    const mid = (db.query("SELECT id FROM messages WHERE uid = 'msg-uid-two'").get() as any).id;
    expect(lookupId(db, "msg-uid-two")).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: mid,
      kind: "message",
    });
  });

  it("resolves a unique bare native-id prefix (≥6 chars)", () => {
    expect(lookupId(db, CC_UUID.slice(0, 8))).toEqual({
      sessionId: `claude-code:${CC_UUID}`,
      messageId: null,
      kind: "session",
    });
  });

  it("returns null on ambiguous prefixes and short queries", () => {
    expect(lookupId(db, "7de4a1")).toBeNull(); // ambiguous: prefixes both CC sessions
    expect(lookupId(db, "cc·7de4a1")).toBeNull(); // still ambiguous with the agent prefix
    expect(lookupId(db, "7de4")).toBeNull(); // ≥4 but core < 6 chars → no prefix lookup
    expect(lookupId(db, "abc")).toBeNull(); // < 4 chars
    expect(lookupId(db, "  ab  ")).toBeNull(); // trims to < 4
    expect(lookupId(db, "zzzzzzzz")).toBeNull(); // no match at all
  });
});
