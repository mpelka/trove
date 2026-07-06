import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client.ts";
import { sync } from "../ingest/sync.ts";
import { searchSessions } from "../search/search.ts";
import { chatgptWebAdapter } from "./chatgpt-web.ts";

// ── deterministic hand-written fixture (no external export file) ─────────────
// Covers: a plain-text conversation; a multimodal one (image_asset_pointer); and one with
// an edit-branch where current_node follows only one path (the dead branch must be dropped).

function node(id: string, parent: string | null, message: unknown, children: string[] = []) {
  return { id, parent, message, children };
}
function userMsg(id: string, text: string, t: number) {
  return {
    id,
    author: { role: "user" },
    create_time: t,
    content: { content_type: "text", parts: [text] },
    metadata: {},
  };
}
function asstMsg(id: string, text: string, t: number, model = "gpt-4o") {
  return {
    id,
    author: { role: "assistant" },
    create_time: t,
    content: { content_type: "text", parts: [text] },
    metadata: { model_slug: model },
  };
}

// Conversation A: plain 2-turn chat.
const convPlain = {
  conversation_id: "aaaa-1111",
  title: "Plain chat",
  create_time: 1000,
  update_time: 1100,
  current_node: "a-n3",
  is_archived: false,
  is_starred: true,
  mapping: {
    "a-root": node("a-root", null, null, ["a-n1"]),
    "a-n1": node("a-n1", "a-root", userMsg("a-n1", "Hello there", 1000), ["a-n2"]),
    "a-n2": node("a-n2", "a-n1", asstMsg("a-n2", "Hi! How can I help?", 1010), ["a-n3"]),
    "a-n3": node("a-n3", "a-n2", userMsg("a-n3", "Tell me a joke", 1020), []),
  },
};

// Conversation B: multimodal user message with an image asset pointer.
const convImage = {
  conversation_id: "bbbb-2222",
  title: "Image chat",
  create_time: 2000,
  update_time: 2100,
  current_node: "b-n2",
  is_archived: false,
  is_starred: false,
  mapping: {
    "b-root": node("b-root", null, null, ["b-n1"]),
    "b-n1": node(
      "b-n1",
      "b-root",
      {
        id: "b-n1",
        author: { role: "user" },
        create_time: 2000,
        content: {
          content_type: "multimodal_text",
          parts: [
            { content_type: "image_asset_pointer", asset_pointer: "file-service://file-XYZ" },
            "What is in this picture?",
          ],
        },
        metadata: {},
      },
      ["b-n2"],
    ),
    "b-n2": node("b-n2", "b-n1", asstMsg("b-n2", "A cat.", 2010, "gpt-4"), []),
  },
};

// Conversation C: an edit-branch. current_node walks n1 → n2b; the n2a branch is dead.
const convBranch = {
  conversation_id: "cccc-3333",
  title: "Branched chat",
  create_time: 3000,
  update_time: 3100,
  current_node: "c-n2b",
  is_archived: true,
  is_starred: false,
  mapping: {
    "c-root": node("c-root", null, null, ["c-n1"]),
    "c-n1": node("c-n1", "c-root", userMsg("c-n1", "Original question", 3000), ["c-n2a", "c-n2b"]),
    "c-n2a": node("c-n2a", "c-n1", asstMsg("c-n2a", "DEAD BRANCH ANSWER", 3005), []),
    "c-n2b": node("c-n2b", "c-n1", asstMsg("c-n2b", "LIVE BRANCH ANSWER", 3010), []),
  },
};

let dir: string;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

function writeExport() {
  const importDir = join(dir, "imports", "chatgpt");
  mkdirSync(importDir, { recursive: true });
  writeFileSync(
    join(importDir, "conversations.json"),
    JSON.stringify([convPlain, convImage, convBranch]),
  );
  // Asset-name map for [image: <name>] resolution.
  writeFileSync(
    join(importDir, "conversation_asset_file_names.json"),
    JSON.stringify({ "file-XYZ.dat": "cat.png" }),
  );
  return importDir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-chatgpt-"));
  process.env.TROVE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("chatgpt-web adapter", () => {
  it("enumerate() returns [] when the imports dir is absent", async () => {
    const refs = await chatgptWebAdapter.enumerate();
    expect(refs).toEqual([]);
  });

  it("enumerate() yields one ref per conversation and ignores non-ChatGPT json", async () => {
    const importDir = writeExport();
    // A JSON file that is NOT a ChatGPT export must be skipped by the signature guard.
    writeFileSync(join(importDir, "conversations.json.bak"), JSON.stringify([{ foo: 1 }]));
    // (glob only matches conversations.json, but drop an unrelated one at that name elsewhere)
    mkdirSync(join(importDir, "other"), { recursive: true });
    writeFileSync(join(importDir, "other", "conversations.json"), JSON.stringify([{ foo: 1 }]));

    const refs = await chatgptWebAdapter.enumerate();
    expect(refs.length).toBe(3);
    const ids = refs.map((r) => r.nativeIdHint).sort();
    expect(ids).toEqual(["aaaa-1111", "bbbb-2222", "cccc-3333"]);
    for (const r of refs) {
      expect(r.agent).toBe("chatgpt");
      expect(r.medium).toBe("file");
      expect(r.path).toContain("#");
    }
  });

  it("parse() linearizes a plain conversation with correct order/roles/title/model", async () => {
    writeExport();
    const refs = await chatgptWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "aaaa-1111")!;
    const res = await chatgptWebAdapter.parse(ref);
    expect(res).not.toBeNull();
    const s = res!.session;
    expect(s.nativeId).toBe("aaaa-1111");
    expect(s.sourceTitle).toBe("Plain chat");
    expect(s.kind).toBe("chat");
    expect(s.createdAt).toBe(1000_000);
    expect(s.updatedAt).toBe(1100_000);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(s.messages.map((m) => m.text)).toEqual([
      "Hello there",
      "Hi! How can I help?",
      "Tell me a joke",
    ]);
    // timestamps are epoch-ms (seconds * 1000).
    expect(s.messages[0]!.timestamp).toBe(1000_000);
    // seq is 0-based; parentUid threads the previous kept message.
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(s.messages[0]!.parentUid).toBeNull();
    expect(s.messages[1]!.parentUid).toBe("a-n1");
    // model = the last assistant message's slug.
    expect(s.model).toBe("gpt-4o");
    // agentSpecific carries the URL + flags.
    expect(s.agentSpecific!.url).toBe("https://chatgpt.com/c/aaaa-1111");
    expect(s.agentSpecific!.isStarred).toBe(true);
    expect(s.agentSpecific!.exportFile).toBe(join("chatgpt", "conversations.json"));
  });

  it("parse() renders an image reference from multimodal content", async () => {
    writeExport();
    const refs = await chatgptWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "bbbb-2222")!;
    const s = (await chatgptWebAdapter.parse(ref))!.session;
    // image marker resolved via the asset-name map, then the prose part.
    expect(s.messages[0]!.text).toBe("[image: cat.png]\nWhat is in this picture?");
    expect(s.model).toBe("gpt-4");
  });

  it("parse() follows only the active branch, dropping dead edit-branches", async () => {
    writeExport();
    const refs = await chatgptWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "cccc-3333")!;
    const s = (await chatgptWebAdapter.parse(ref))!.session;
    const texts = s.messages.map((m) => m.text);
    expect(texts).toContain("LIVE BRANCH ANSWER");
    expect(texts).not.toContain("DEAD BRANCH ANSWER");
    expect(s.messages.length).toBe(2);
  });

  it("parse() produces a stable contentHash", async () => {
    writeExport();
    const refs = await chatgptWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "aaaa-1111")!;
    const h1 = (await chatgptWebAdapter.parse(ref))!.contentHash;
    const h2 = (await chatgptWebAdapter.parse(ref))!.contentHash;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sync() ingests chatgpt sessions that are FTS-searchable", async () => {
    writeExport();
    const db: Database = openDb(join(dir, "test.db"));
    try {
      const r = await sync(db, [chatgptWebAdapter]);
      expect(r.added).toBe(3);
      expect(r.perAgent.chatgpt.sessions).toBe(3);

      const rows = db
        .query("SELECT id, agent, native_id FROM sessions WHERE agent = 'chatgpt'")
        .all() as Array<{ id: string; agent: string; native_id: string }>;
      expect(rows.length).toBe(3);
      expect(rows.every((x) => x.agent === "chatgpt")).toBe(true);

      // FTS: search for text that only appears in the live branch.
      const hits = searchSessions(db, { query: "LIVE BRANCH", agent: "chatgpt" });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe("chatgpt:cccc-3333");

      // The dead-branch text must NOT be searchable (it was never ingested).
      const dead = searchSessions(db, { query: "DEAD BRANCH", agent: "chatgpt" });
      expect(dead.length).toBe(0);
    } finally {
      db.close();
    }
  });
});
