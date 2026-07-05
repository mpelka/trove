import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db/client.ts";
import {
  addHighlight,
  removeHighlight,
  listHighlights,
  highlightsForSession,
} from "./highlights.ts";
import { deleteSession } from "./curate.ts";
import { getSessionDetail } from "./queries.ts";

let dir: string;
let db: Database;

const S1 = "claude-code:sess-one";
const S2 = "gemini-cli:sess-two";

function seedSession(id: string, agent: string, title: string) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, source_title,
       content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, agent, id.split(":")[1], `/src/${id}`, "file", title, "h", Date.now());
}

function seedMessage(id: string, seq: number, uid: string | null, text: string) {
  db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run(uid, id, seq, "assistant", null, 1000 + seq, text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-hl-"));
  db = openDb(join(dir, "hl.db"));
  seedSession(S1, "claude-code", "Session one");
  seedSession(S2, "gemini-cli", "Session two");
  seedMessage(S1, 0, "uid-a", "the quick brown fox");
  seedMessage(S1, 1, "uid-b", "jumps over the lazy dog");
  seedMessage(S2, 0, "uid-c", "hello world");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("addHighlight / listHighlights", () => {
  it("stores an anchored highlight and lists it with session name + resolved rowid", () => {
    const rowid = (db.query("SELECT id FROM messages WHERE uid = 'uid-a'").get() as any).id;
    const id = addHighlight(db, {
      sessionId: S1,
      messageUid: "uid-a",
      messageSeq: 0,
      text: "quick brown fox",
      note: "nice phrase",
    });
    expect(id).toBeGreaterThan(0);

    const hits = listHighlights(db);
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.text).toBe("quick brown fox");
    expect(h.note).toBe("nice phrase");
    expect(h.sessionName).toBe("Session one");
    expect(h.agent).toBe("claude-code");
    expect(h.messageId).toBe(rowid); // resolved via uid
  });

  it("rejects empty text", () => {
    expect(() => addHighlight(db, { sessionId: S1, text: "  " })).toThrow();
  });

  it("filters by sessionId and honours limit, newest first", () => {
    addHighlight(db, { sessionId: S1, messageUid: "uid-a", messageSeq: 0, text: "one" });
    addHighlight(db, { sessionId: S2, messageUid: "uid-c", messageSeq: 0, text: "two" });
    addHighlight(db, { sessionId: S1, messageUid: "uid-b", messageSeq: 1, text: "three" });

    expect(listHighlights(db, { sessionId: S1 }).map((h) => h.text)).toEqual(["three", "one"]);
    expect(listHighlights(db, { sessionId: S2 }).map((h) => h.text)).toEqual(["two"]);
    expect(listHighlights(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("resolution fallbacks", () => {
  it("resolves via seq when the uid no longer matches any message", () => {
    const rowid = (db.query("SELECT id FROM messages WHERE seq = 1 AND session_id = ?").get(S1) as any).id;
    addHighlight(db, { sessionId: S1, messageUid: "stale-uid", messageSeq: 1, text: "lazy dog" });
    expect(listHighlights(db, { sessionId: S1 })[0].messageId).toBe(rowid);
  });

  it("keeps a highlight (messageId null) even when its message vanishes entirely", () => {
    addHighlight(db, { sessionId: S1, messageUid: "gone-uid", messageSeq: 99, text: "orphaned" });
    const h = listHighlights(db, { sessionId: S1 })[0];
    expect(h.text).toBe("orphaned");
    expect(h.messageId).toBeNull();
  });
});

describe("removeHighlight", () => {
  it("deletes by id", () => {
    const id = addHighlight(db, { sessionId: S1, messageUid: "uid-a", messageSeq: 0, text: "x" });
    removeHighlight(db, id);
    expect(listHighlights(db)).toHaveLength(0);
  });
});

describe("highlightsForSession", () => {
  it("returns the session's highlights in insertion order", () => {
    addHighlight(db, { sessionId: S1, messageUid: "uid-a", messageSeq: 0, text: "first" });
    addHighlight(db, { sessionId: S1, messageUid: "uid-b", messageSeq: 1, text: "second" });
    addHighlight(db, { sessionId: S2, messageUid: "uid-c", messageSeq: 0, text: "other" });
    const rows = highlightsForSession(db, S1);
    expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
    expect(rows[0].messageUid).toBe("uid-a");
  });
});

describe("getSessionDetail includes highlights", () => {
  it("threads the session's highlights through the detail shape", () => {
    addHighlight(db, { sessionId: S1, messageUid: "uid-a", messageSeq: 0, text: "detailed" });
    const d = getSessionDetail(db, S1)!;
    expect(d.highlights).toHaveLength(1);
    expect(d.highlights[0].text).toBe("detailed");
  });
});

describe("deleteSession cascades to highlights", () => {
  it("removes a session's highlights when the session is deleted", () => {
    addHighlight(db, { sessionId: S1, messageUid: "uid-a", messageSeq: 0, text: "doomed" });
    addHighlight(db, { sessionId: S2, messageUid: "uid-c", messageSeq: 0, text: "survivor" });
    deleteSession(db, S1);
    expect(listHighlights(db).map((h) => h.text)).toEqual(["survivor"]);
  });
});
