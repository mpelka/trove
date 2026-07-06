import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client.ts";
import { sync } from "../ingest/sync.ts";
import { searchSessions } from "../search/search.ts";
import { claudeWebAdapter } from "./claude-web.ts";

// ── deterministic hand-written fixture (no external export file) ─────────────
// Covers: a real conversation (human text + assistant text + tool_use + attachment); a
// zero-message shell and a messages-but-no-prose shell (both SKIPPED by parse()); a
// non-claude (ChatGPT-shaped) json that the signature guard must ignore.

// Conversation A: a real exchange. Human asks (with an attachment), assistant answers with a
// tool_use block plus prose, then a tool-only assistant turn (only tool_use, no prose).
const convReal = {
  uuid: "conv-real-1",
  name: "Real conversation",
  summary: "A quick chat",
  created_at: "2024-08-26T10:33:29.758169Z",
  updated_at: "2024-08-26T10:40:00.000000Z",
  account: { uuid: "acct-1" },
  chat_messages: [
    {
      uuid: "m1",
      sender: "human",
      created_at: "2024-08-26T10:33:29.758169Z",
      updated_at: "2024-08-26T10:33:29.758169Z",
      parent_message_uuid: null,
      text: "How do I read a file?",
      content: [{ type: "text", text: "How do I read a file?" }],
      attachments: [{ file_name: "notes.txt", file_size: 42, file_type: "text/plain", extracted_content: "SECRET BODY" }],
      files: [],
    },
    {
      uuid: "m2",
      sender: "assistant",
      created_at: "2024-08-26T10:34:00.000000Z",
      updated_at: "2024-08-26T10:34:00.000000Z",
      parent_message_uuid: "m1",
      text: "Here you go.",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "Here you go." },
        { type: "tool_use", name: "read_file", input: { file_path: "/etc/hosts" } },
      ],
      attachments: [],
      files: [],
    },
    {
      uuid: "m3",
      sender: "assistant",
      created_at: "2024-08-26T10:35:00.000000Z",
      updated_at: "2024-08-26T10:35:00.000000Z",
      parent_message_uuid: "m2",
      text: "",
      content: [
        { type: "tool_use", name: "bash", input: { command: "cat /etc/hosts" } },
        { type: "tool_result", content: "127.0.0.1 localhost" },
      ],
      attachments: [],
      files: [],
    },
  ],
};

// Conversation B: zero messages — an empty shell (enumerate skips it entirely).
const convZero = {
  uuid: "conv-zero-2",
  name: "",
  summary: "",
  created_at: "2024-01-01T00:00:00.000000Z",
  updated_at: "2024-01-01T00:00:00.000000Z",
  account: { uuid: "acct-1" },
  chat_messages: [],
};

// Conversation C: has messages but no usable prose (only thinking/tool_result → dropped, and
// empty text fields). parse() must return null.
const convNoProse = {
  uuid: "conv-noprose-3",
  name: "",
  summary: "",
  created_at: "2024-02-02T00:00:00.000000Z",
  updated_at: "2024-02-02T00:00:00.000000Z",
  account: { uuid: "acct-1" },
  chat_messages: [
    {
      uuid: "c1",
      sender: "human",
      created_at: "2024-02-02T00:00:00.000000Z",
      updated_at: "2024-02-02T00:00:00.000000Z",
      parent_message_uuid: null,
      text: "",
      content: [{ type: "thinking", thinking: "hmm" }],
      attachments: [],
      files: [],
    },
    {
      uuid: "c2",
      sender: "assistant",
      created_at: "2024-02-02T00:00:01.000000Z",
      updated_at: "2024-02-02T00:00:01.000000Z",
      parent_message_uuid: "c1",
      text: "",
      content: [{ type: "tool_result", content: "junk" }],
      attachments: [],
      files: [],
    },
  ],
};

// A ChatGPT-shaped export (mapping + conversation_id, no chat_messages/account) — the claude
// signature guard must reject it.
const chatgptShaped = [
  { conversation_id: "gpt-1", title: "GPT", mapping: { root: { id: "root", message: null } } },
];

let dir: string;
const OLD_TROVE_DIR = process.env.TROVE_DIR;

function writeExport() {
  const importDir = join(dir, "imports", "claude");
  mkdirSync(importDir, { recursive: true });
  writeFileSync(
    join(importDir, "conversations.json"),
    JSON.stringify([convReal, convZero, convNoProse]),
  );
  return importDir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trove-claudeweb-"));
  process.env.TROVE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (OLD_TROVE_DIR === undefined) delete process.env.TROVE_DIR;
  else process.env.TROVE_DIR = OLD_TROVE_DIR;
});

describe("claude-web adapter", () => {
  it("enumerate() returns [] when the imports dir is absent", async () => {
    const refs = await claudeWebAdapter.enumerate();
    expect(refs).toEqual([]);
  });

  it("enumerate() lists only conversations with ≥1 message and ignores non-claude json", async () => {
    const importDir = writeExport();
    // A ChatGPT-shaped export at another conversations.json — must be skipped by the guard.
    mkdirSync(join(importDir, "other"), { recursive: true });
    writeFileSync(join(importDir, "other", "conversations.json"), JSON.stringify(chatgptShaped));

    const refs = await claudeWebAdapter.enumerate();
    // convZero has zero messages → not even listed; convReal + convNoProse are.
    const ids = refs.map((r) => r.nativeIdHint).sort();
    expect(ids).toEqual(["conv-noprose-3", "conv-real-1"]);
    for (const r of refs) {
      expect(r.agent).toBe("claude-web");
      expect(r.medium).toBe("file");
      expect(r.path).toContain("#");
    }
  });

  it("parse() extracts prose, tool_calls, attachment ref, threading and timestamps", async () => {
    writeExport();
    const refs = await claudeWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "conv-real-1")!;
    const res = await claudeWebAdapter.parse(ref);
    expect(res).not.toBeNull();
    const s = res!.session;

    expect(s.nativeId).toBe("conv-real-1");
    expect(s.sourceTitle).toBe("Real conversation");
    expect(s.kind).toBe("chat");
    expect(s.model).toBeNull();
    expect(s.projectPath).toBeNull();

    // Roles: human → user; assistant w/ prose → assistant; assistant w/ only tool_use → tool.
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    // Human prose + attachment reference appended (extracted_content NEVER included).
    expect(s.messages[0]!.text).toBe("How do I read a file?\n[attachment: notes.txt]");
    expect(s.messages[0]!.text).not.toContain("SECRET BODY");

    // Assistant prose kept; thinking dropped; tool_use captured as a toolCall.
    expect(s.messages[1]!.text).toBe("Here you go.");
    expect(s.messages[1]!.toolCalls).toEqual([{ name: "read_file", input: '{"file_path":"/etc/hosts"}' }]);

    // Tool-only turn → `[used: …]` marker + a command-based toolCall.
    expect(s.messages[2]!.text).toBe("[used: bash]");
    expect(s.messages[2]!.toolCalls).toEqual([{ name: "bash", input: "cat /etc/hosts" }]);

    // Threading via parent_message_uuid + timestamps parsed from ISO strings.
    expect(s.messages[0]!.parentUid).toBeNull();
    expect(s.messages[1]!.parentUid).toBe("m1");
    expect(s.messages[0]!.timestamp).toBe(Date.parse("2024-08-26T10:33:29.758169Z"));
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2]);

    // agentSpecific carries the url + export file + summary.
    expect(s.agentSpecific!.url).toBe("https://claude.ai/chat/conv-real-1");
    expect(s.agentSpecific!.conversationUuid).toBe("conv-real-1");
    expect(s.agentSpecific!.summary).toBe("A quick chat");
    expect(s.agentSpecific!.exportFile).toBe(join("claude", "conversations.json"));

    expect(s.createdAt).toBe(Date.parse("2024-08-26T10:33:29.758169Z"));
    expect(s.updatedAt).toBe(Date.parse("2024-08-26T10:40:00.000000Z"));
  });

  it("parse() returns null for a messages-but-no-prose shell", async () => {
    writeExport();
    const refs = await claudeWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "conv-noprose-3")!;
    const res = await claudeWebAdapter.parse(ref);
    expect(res).toBeNull();
  });

  it("parse() produces a stable contentHash", async () => {
    writeExport();
    const refs = await claudeWebAdapter.enumerate();
    const ref = refs.find((r) => r.nativeIdHint === "conv-real-1")!;
    const h1 = (await claudeWebAdapter.parse(ref))!.contentHash;
    const h2 = (await claudeWebAdapter.parse(ref))!.contentHash;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sync() ingests only real conversations, FTS-searchable, agent=claude-web", async () => {
    writeExport();
    const db: Database = openDb(join(dir, "test.db"));
    try {
      const r = await sync(db, [claudeWebAdapter]);
      // Only convReal lands (convZero not listed; convNoProse parse→null).
      expect(r.added).toBe(1);
      expect(r.perAgent["claude-web"].sessions).toBe(1);

      const rows = db
        .query("SELECT id, agent, native_id FROM sessions WHERE agent = 'claude-web'")
        .all() as Array<{ id: string; agent: string; native_id: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.agent).toBe("claude-web");
      expect(rows[0]!.native_id).toBe("conv-real-1");

      // FTS: prose from the real conversation is searchable.
      const hits = searchSessions(db, { query: "read a file", agent: "claude-web" });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe("claude-web:conv-real-1");

      // The dropped thinking/tool_result bodies are NOT searchable.
      const secret = searchSessions(db, { query: "SECRET BODY", agent: "claude-web" });
      expect(secret.length).toBe(0);
    } finally {
      db.close();
    }
  });
});
