import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client.ts";
import { searchMessages, searchSessions } from "./search.ts";

let dir: string;
let db: Database;

function seedSession(id: string, agent: string, projectPath: string | null, title: string) {
  db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, project_path,
       source_title, content_hash, imported_at, source_gone)
     VALUES (?,?,?,?,?,?,?,?,?,0)`,
  ).run(id, agent, id.split(":")[1], `/src/${id}`, "file", projectPath, title, "h", Date.now());
}

function seedMessage(sessionId: string, seq: number, role: string, text: string, ts: number) {
  db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  ).run(`${sessionId}-u${seq}`, sessionId, seq, role, null, ts, text);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-search-"));
  db = openDb(join(dir, "search.db")); // real file → WAL applies, FTS triggers exercised

  seedSession("claude-code:s1", "claude-code", "/Users/x/alpha", "Alpha session");
  seedSession("gemini-cli:s2", "gemini-cli", "/Users/x/beta", "Beta session");
  seedSession("claude-code:s3", "claude-code", null, "Quiet session");

  seedMessage("claude-code:s1", 0, "user", "the quick brown fox jumps over the lazy dog", 1000);
  seedMessage("claude-code:s1", 1, "assistant", "a quick quicksort implementation in rust", 2000);
  seedMessage("gemini-cli:s2", 0, "user", "my quick brown terrier barked", 3000);
  seedMessage("gemini-cli:s2", 1, "assistant", "totally unrelated words here", 400);
  seedMessage("claude-code:s3", 0, "user", "nothing matching in this one", 500);

  db.query("INSERT INTO session_meta (session_id, starred, tags) VALUES (?,?,?)").run(
    "claude-code:s1",
    1,
    JSON.stringify(["rust", "cli"]),
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("searchMessages", () => {
  it("matches via FTS with implicit prefix expansion", () => {
    // "quic" only matches because terms are turned into prefix queries ("quic"*)
    const hits = searchMessages(db, { query: "quic" });
    expect(hits.length).toBe(3);
    for (const h of hits) expect(h.snippet).toContain("«");
  });

  it("treats multiple terms as AND (both must match)", () => {
    const hits = searchMessages(db, { query: "quick brown" });
    expect(hits.map((h) => h.sessionId).sort()).toEqual(["claude-code:s1", "gemini-cli:s2"]);
  });

  it("exact mode searches the phrase, not the terms", () => {
    const exact = searchMessages(db, { query: "quick brown", exact: true });
    expect(exact.length).toBe(2); // "quick brown fox", "quick brown terrier"
    const phraseOnly = searchMessages(db, { query: "brown fox", exact: true });
    expect(phraseOnly.length).toBe(1);
    expect(phraseOnly[0].sessionId).toBe("claude-code:s1");
    // non-exact "fox brown" matches (AND), exact "fox brown" does not (order matters)
    expect(searchMessages(db, { query: "fox brown" }).length).toBe(1);
    expect(searchMessages(db, { query: "fox brown", exact: true }).length).toBe(0);
  });

  it("does not throw on FTS5 special characters", () => {
    for (const q of ['"', "*", "AND", "(", "co:lon", 'trailing"', "NEAR", "-minus", "a AND b OR c*"]) {
      expect(() => searchMessages(db, { query: q })).not.toThrow();
      expect(() => searchMessages(db, { query: q, exact: true })).not.toThrow();
    }
  });

  it("enriches hits with session fields and meta", () => {
    const hits = searchMessages(db, { query: "quicksort" });
    expect(hits.length).toBe(1);
    const h = hits[0];
    expect(h.agent).toBe("claude-code");
    expect(h.projectPath).toBe("/Users/x/alpha");
    expect(h.title).toBe("Alpha session");
    expect(h.starred).toBe(true);
    expect(h.sourceGone).toBe(false);
    expect(h.role).toBe("assistant");
    expect(h.seq).toBe(1);
    expect(typeof h.messageId).toBe("number");
  });

  it("applies agent / star / tag / project filters", () => {
    expect(searchMessages(db, { query: "quick", agent: "gemini-cli" }).map((h) => h.sessionId)).toEqual([
      "gemini-cli:s2",
    ]);
    const starred = searchMessages(db, { query: "quick", star: true });
    expect(new Set(starred.map((h) => h.sessionId))).toEqual(new Set(["claude-code:s1"]));
    const tagged = searchMessages(db, { query: "quick", tag: "rust" });
    expect(new Set(tagged.map((h) => h.sessionId))).toEqual(new Set(["claude-code:s1"]));
    expect(searchMessages(db, { query: "quick", tag: "nope" })).toEqual([]);
    const proj = searchMessages(db, { query: "quick", project: "beta" });
    expect(proj.map((h) => h.sessionId)).toEqual(["gemini-cli:s2"]);
  });

  it("applies since / until on message timestamps", () => {
    expect(searchMessages(db, { query: "quick", since: 2500 }).map((h) => h.timestamp)).toEqual([3000]);
    expect(searchMessages(db, { query: "quick", until: 1500 }).map((h) => h.timestamp)).toEqual([1000]);
    expect(searchMessages(db, { query: "quick", since: 1500, until: 2500 }).map((h) => h.timestamp)).toEqual([2000]);
  });

  it("sorts by recency when asked, by bm25 score otherwise", () => {
    const recent = searchMessages(db, { query: "quick", sort: "recent" });
    expect(recent.map((h) => h.timestamp)).toEqual([3000, 2000, 1000]);
    const rel = searchMessages(db, { query: "quick" });
    const scores = rel.map((h) => h.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores); // bm25: lower (more negative) = better
  });

  it("respects limit", () => {
    expect(searchMessages(db, { query: "quick", limit: 1 }).length).toBe(1);
  });

  it("returns nothing for an empty query", () => {
    expect(searchMessages(db, { query: "   " })).toEqual([]);
  });
});

describe("searchSessions", () => {
  it("groups hits per session with matchCount and best snippet", () => {
    const sessions = searchSessions(db, { query: "quick" });
    expect(sessions.length).toBe(2);
    const s1 = sessions.find((s) => s.sessionId === "claude-code:s1")!;
    const s2 = sessions.find((s) => s.sessionId === "gemini-cli:s2")!;
    expect(s1.matchCount).toBe(2);
    expect(s2.matchCount).toBe(1);
    expect(s1.starred).toBe(true);
    expect(s1.bestSnippet).toContain("«quick»");
    // relevance order: bestScore ascending
    expect(sessions[0].bestScore).toBeLessThanOrEqual(sessions[1].bestScore);
  });

  it("sorts sessions by best timestamp with sort=recent", () => {
    const sessions = searchSessions(db, { query: "quick", sort: "recent" });
    expect(sessions[0].sessionId).toBe("gemini-cli:s2"); // ts 3000 beats s1
  });

  it("applies limit after grouping", () => {
    const sessions = searchSessions(db, { query: "quick", limit: 1 });
    expect(sessions.length).toBe(1);
  });
});

describe("FTS triggers", () => {
  it("keeps the index in sync on delete and update", () => {
    seedSession("claude-code:tmp", "claude-code", null, "tmp");
    seedMessage("claude-code:tmp", 0, "user", "zanzibar unique token", 100);
    expect(searchMessages(db, { query: "zanzibar" }).length).toBe(1);

    db.query("UPDATE messages SET text = 'xylophone instead' WHERE session_id = 'claude-code:tmp'").run();
    expect(searchMessages(db, { query: "zanzibar" }).length).toBe(0);
    expect(searchMessages(db, { query: "xylophone" }).length).toBe(1);

    db.query("DELETE FROM messages WHERE session_id = 'claude-code:tmp'").run();
    expect(searchMessages(db, { query: "xylophone" }).length).toBe(0);
    db.query("DELETE FROM sessions WHERE id = 'claude-code:tmp'").run();
  });
});
