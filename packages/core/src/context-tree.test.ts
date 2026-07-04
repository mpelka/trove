import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import { getContext, getTree } from "./context-tree.ts";

let dir: string;
let db: Database;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

// Linked session (CC-style parent_uid chain): u0 → u1 → u2 → u3 → u4.
const CC = "claude-code:link";
// Flat session (gemini-style, no parent links).
const GEM = "gemini-cli:flat";

let ccIds: number[] = [];
let gemIds: number[] = [];

function seedSession(id: string, agent: string, nativeId: string) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium,
       content_hash, imported_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, agent, nativeId, `/src/${nativeId}`, "file", "h", Date.now());
}

function seedMessage(
  sessionId: string,
  seq: number,
  uid: string | null,
  parentUid: string | null,
  text: string,
): number {
  db.query(
    "INSERT INTO messages (session_id, seq, role, uid, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run(sessionId, seq, seq % 2 ? "assistant" : "user", uid, parentUid, 100 + seq, text);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-ctxtree-"));
  process.env.TROVE_DIR = dir;
  db = openDb(join(dir, "trove.db"));

  seedSession(CC, "claude-code", "link");
  const chain = ["u0", "u1", "u2", "u3", "u4"];
  let parent: string | null = null;
  ccIds = chain.map((uid, i) => {
    const rowid = seedMessage(CC, i, uid, parent, `msg ${uid}`);
    parent = uid;
    return rowid;
  });

  seedSession(GEM, "gemini-cli", "flat");
  gemIds = ["g0", "g1", "g2", "g3", "g4"].map((label, i) =>
    seedMessage(GEM, i, null, null, `flat ${label}`),
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("getContext", () => {
  it("walks the parent_uid chain in both directions when links exist", () => {
    const r = getContext(db, ccIds[2], 3)!; // target = u2
    expect(r.sessionId).toBe(CC);
    expect(r.target.id).toBe(ccIds[2]);
    // ancestors u0,u1 (only 2 available) + target u2 + descendants u3,u4
    expect(r.messages.map((m) => m.text)).toEqual([
      "msg u0",
      "msg u1",
      "msg u2",
      "msg u3",
      "msg u4",
    ]);
    expect(r.messages.filter((m) => m.isTarget).map((m) => m.id)).toEqual([ccIds[2]]);
  });

  it("respects depth on the linked chain", () => {
    const r = getContext(db, ccIds[2], 1)!;
    expect(r.messages.map((m) => m.text)).toEqual(["msg u1", "msg u2", "msg u3"]);
  });

  it("falls back to seq-adjacency for a flat session", () => {
    const r = getContext(db, gemIds[2], 2)!;
    expect(r.messages.map((m) => m.text)).toEqual([
      "flat g0",
      "flat g1",
      "flat g2",
      "flat g3",
      "flat g4",
    ]);
    expect(r.messages.find((m) => m.isTarget)!.id).toBe(gemIds[2]);
  });

  it("clamps at session edges", () => {
    const first = getContext(db, ccIds[0], 3)!;
    expect(first.messages[0].isTarget).toBe(true); // no ancestors
    const last = getContext(db, gemIds[4], 3)!;
    expect(last.messages[last.messages.length - 1].isTarget).toBe(true); // no successors
  });

  it("returns null for an unknown message id", () => {
    expect(getContext(db, 999999)).toBeNull();
  });
});

describe("getTree", () => {
  it("builds a linked tree from parent_uid", () => {
    const t = getTree(db, CC)!;
    expect(t.linked).toBe(true);
    expect(t.roots.length).toBe(1); // u0 is the sole root
    expect(t.roots[0].text).toBe("msg u0");
    // linear chain: each node has exactly one child down to u4
    let node = t.roots[0];
    const chain = [node.text];
    while (node.children.length) {
      node = node.children[0];
      chain.push(node.text);
    }
    expect(chain).toEqual(["msg u0", "msg u1", "msg u2", "msg u3", "msg u4"]);
  });

  it("degrades to a flat single level when there are no links", () => {
    const t = getTree(db, GEM)!;
    expect(t.linked).toBe(false);
    expect(t.roots.map((n) => n.text)).toEqual([
      "flat g0",
      "flat g1",
      "flat g2",
      "flat g3",
      "flat g4",
    ]);
    expect(t.roots.every((n) => n.children.length === 0)).toBe(true);
  });

  it("treats a dangling parent_uid as a root", () => {
    const sid = "claude-code:dangle";
    seedSession(sid, "claude-code", "dangle");
    seedMessage(sid, 0, "d0", "does-not-exist", "orphan root");
    const child = seedMessage(sid, 1, "d1", "d0", "real child");
    const t = getTree(db, sid)!;
    expect(t.linked).toBe(true);
    expect(t.roots.map((n) => n.text)).toEqual(["orphan root"]);
    expect(t.roots[0].children.map((n) => n.id)).toEqual([child]);
  });

  it("returns null for an unknown session", () => {
    expect(getTree(db, "nope:missing")).toBeNull();
  });
});
