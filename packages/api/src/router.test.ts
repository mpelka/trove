import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type TroveContext } from "@trove/core";
import { appRouter } from "./router.ts";

let dir: string;
let trove: TroveContext;
let caller: ReturnType<typeof appRouter.createCaller>;

const CC_ID = "claude-code:11112222-3333-4444-5555-666677778888";
const GEM_ID = "gemini-cli:session-2025-06-01T10-00-beefbeef";

function seed(db: TroveContext["db"]) {
  const ins = db.query(
    `INSERT INTO sessions (id, agent, native_id, source_path, source_medium, project_path,
       created_at, updated_at, turn_count, message_count, source_title, content_hash, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ins.run(CC_ID, "claude-code", CC_ID.split(":")[1], "/src/cc.jsonl", "file", "/Users/x/alpha", 100, 2000, 1, 2, "CC session", "h", Date.now());
  ins.run(GEM_ID, "gemini-cli", GEM_ID.split(":")[1], "/src/gem.json", "file", "/Users/x/beta", 200, 3000, 1, 1, "Gem session", "h", Date.now());
  const im = db.query(
    "INSERT INTO messages (uid, session_id, seq, role, parent_uid, timestamp, text) VALUES (?,?,?,?,?,?,?)",
  );
  im.run("cc-m1", CC_ID, 0, "user", null, 1000, "please refactor the widget");
  im.run("cc-m2", CC_ID, 1, "assistant", null, 2000, "widget refactored successfully");
  im.run("gem-m1", GEM_ID, 0, "user", null, 3000, "explain the widget pattern");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-router-"));
  const db = openDb(join(dir, "router.db"));
  seed(db);
  trove = { db, adapters: [], close: () => db.close() };
  caller = appRouter.createCaller({ trove });
});

afterAll(() => {
  trove.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("appRouter", () => {
  it("status reports the seeded store", async () => {
    const st = await caller.status();
    expect(st.totalSessions).toBe(2);
    expect(st.totalMessages).toBe(3);
  });

  it("list returns sessions, honouring filters", async () => {
    const all = await caller.list();
    expect(all.map((s) => s.id).sort()).toEqual([CC_ID, GEM_ID].sort());
    const gem = await caller.list({ agent: "gemini-cli" });
    expect(gem.map((s) => s.id)).toEqual([GEM_ID]);
  });

  it("search groups by session by default and returns message hits on demand", async () => {
    const bySession = await caller.search({ query: "widget" });
    expect(bySession.kind).toBe("sessions");
    if (bySession.kind === "sessions") {
      expect(bySession.hits.length).toBe(2);
      const cc = bySession.hits.find((h) => h.sessionId === CC_ID)!;
      expect(cc.matchCount).toBe(2);
    }
    const byMessage = await caller.search({ query: "widget", groupBySession: false });
    expect(byMessage.kind).toBe("messages");
    if (byMessage.kind === "messages") expect(byMessage.hits.length).toBe(3);
  });

  it("resolveId jumps to a session from a short id", async () => {
    const hit = await caller.resolveId({ q: "cc·11112222" });
    expect(hit).toEqual({ sessionId: CC_ID, messageId: null, kind: "session" });
  });

  it("sessionDetail includes a resume command for claude-code", async () => {
    const d = await caller.sessionDetail({ id: CC_ID });
    expect(d).not.toBeNull();
    expect(d!.session.name).toBe("CC session");
    expect(d!.messages.length).toBe(2);
    expect(d!.resumeCommand).toBe(
      `cd '/Users/x/alpha' && claude --resume ${CC_ID.split(":")[1]}`,
    );
  });

  it("sessionDetail is null-safe for unsupported and unknown agents/ids", async () => {
    const gem = await caller.sessionDetail({ id: GEM_ID });
    expect(gem!.resumeCommand).toBeNull(); // gemini resume unsupported
    expect(await caller.sessionDetail({ id: "nope:missing" })).toBeNull();
  });

  it("setStar / addTags / removeTags round-trip through sessionDetail", async () => {
    expect(await caller.setStar({ id: CC_ID, starred: true })).toEqual({ ok: true });
    expect(await caller.addTags({ id: CC_ID, tags: ["b", "a", "a"] })).toEqual({ tags: ["a", "b"] });
    let d = await caller.sessionDetail({ id: CC_ID });
    expect(d!.session.starred).toBe(true);
    expect(d!.session.tags).toEqual(["a", "b"]);
    expect(await caller.removeTags({ id: CC_ID, tags: ["a"] })).toEqual({ tags: ["b"] });
    await caller.setStar({ id: CC_ID, starred: false });
    d = await caller.sessionDetail({ id: CC_ID });
    expect(d!.session.starred).toBe(false);
  });

  it("setName / setNotes / setHidden mutate meta", async () => {
    await caller.setName({ id: GEM_ID, name: "My gem" });
    await caller.setNotes({ id: GEM_ID, notes: "note!" });
    let d = await caller.sessionDetail({ id: GEM_ID });
    expect(d!.session.name).toBe("My gem");
    expect(d!.session.notes).toBe("note!");
    await caller.setName({ id: GEM_ID, name: null });
    d = await caller.sessionDetail({ id: GEM_ID });
    expect(d!.session.name).toBe("Gem session");

    await caller.setHidden({ id: GEM_ID, hidden: true });
    expect((await caller.list()).map((s) => s.id)).toEqual([CC_ID]);
    await caller.setHidden({ id: GEM_ID, hidden: false });
  });

  it("deleteSession removes the session (source untouched — path doesn't exist)", async () => {
    const r = await caller.deleteSession({ id: GEM_ID });
    expect(r.ok).toBe(true);
    expect(await caller.sessionDetail({ id: GEM_ID })).toBeNull();
    expect((await caller.list()).map((s) => s.id)).toEqual([CC_ID]);
  });

  it("addHighlight / highlights / sessionDetail.highlights / removeHighlight round-trip", async () => {
    const add = await caller.addHighlight({
      sessionId: CC_ID,
      messageUid: "cc-m1",
      messageSeq: 0,
      text: "refactor the widget",
      note: "the ask",
    });
    expect(add.id).toBeGreaterThan(0);

    // list (all) joins session name + agent + resolved rowid
    const all = await caller.highlights();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("refactor the widget");
    expect(all[0].agent).toBe("claude-code");
    const ccm1 = (
      trove.db.query("SELECT id FROM messages WHERE uid = 'cc-m1'").get() as { id: number }
    ).id;
    expect(all[0].messageId).toBe(ccm1);

    // per-session filter
    expect(await caller.highlights({ sessionId: GEM_ID })).toHaveLength(0);

    // sessionDetail carries the same highlights in one round-trip
    const d = await caller.sessionDetail({ id: CC_ID });
    expect(d!.highlights).toHaveLength(1);
    expect(d!.highlights[0].messageUid).toBe("cc-m1");

    await caller.removeHighlight({ id: add.id });
    expect(await caller.highlights()).toHaveLength(0);
  });

  it("rejects invalid highlight input via zod", async () => {
    await expect(caller.addHighlight({ sessionId: CC_ID, text: "" })).rejects.toThrow();
    await expect(caller.removeHighlight({ id: -1 })).rejects.toThrow();
  });

  it("context returns the target message with surrounding messages", async () => {
    const mid = (
      trove.db.query("SELECT id FROM messages WHERE uid = 'cc-m2'").get() as { id: number }
    ).id;
    const r = await caller.context({ messageId: mid });
    expect(r).not.toBeNull();
    expect(r!.target.id).toBe(mid);
    expect(r!.messages.find((m) => m.isTarget)!.id).toBe(mid);
    // cc-m2 has parent cc-m1 → the chain includes the earlier message
    expect(r!.messages.map((m) => m.uid)).toContain("cc-m1");
  });

  it("tree returns a session's messages as a tree", async () => {
    // CC messages are seeded with null parent_uid → flat degrade.
    const t = await caller.tree({ id: CC_ID });
    expect(t).not.toBeNull();
    expect(t!.roots.length).toBe(2);
    expect(t!.roots.map((n) => n.uid)).toEqual(["cc-m1", "cc-m2"]);
    expect(await caller.tree({ id: "nope:missing" })).toBeNull();
  });

  it("rejects invalid input via zod", async () => {
    await expect(caller.search({ query: "" })).rejects.toThrow(); // min(1)
    await expect(caller.search({ query: "x", limit: 500 })).rejects.toThrow(); // max(200)
    await expect(caller.search({ query: "x", limit: -1 })).rejects.toThrow(); // positive int
    // @ts-expect-error — sort must be one of the enum values
    await expect(caller.search({ query: "x", sort: "chaotic" })).rejects.toThrow();
    // @ts-expect-error — list limit is capped at 500
    await expect(caller.list({ limit: 10_000, sort: "sideways" })).rejects.toThrow();
  });
});
