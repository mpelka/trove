import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiCliAdapter } from "./gemini-cli.ts";
import type { SourceRef } from "./types.ts";

let root: string;
const OLD_ROOT = process.env.TROVE_GEMINI_ROOT;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trove-gem-"));
  process.env.TROVE_GEMINI_ROOT = root;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (OLD_ROOT === undefined) delete process.env.TROVE_GEMINI_ROOT;
  else process.env.TROVE_GEMINI_ROOT = OLD_ROOT;
});

/** Write a session fixture at <root>/<hash>/chats/<name> (the layout parse expects). */
function writeSession(hash: string, name: string, body: unknown): string {
  const dir = join(root, hash, "chats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

function refFor(path: string): SourceRef {
  const st = statSync(path);
  return {
    agent: "gemini-cli",
    medium: "file",
    path,
    sizeBytes: st.size,
    mtimeMs: Math.floor(st.mtimeMs),
  };
}

const MAIN_SESSION = {
  sessionId: "gem-content-session-id",
  projectHash: "hash1",
  startTime: "2025-06-01T10:00:00.000Z",
  lastUpdated: "2025-06-01T11:00:00.000Z",
  messages: [
    {
      id: "m1",
      type: "user",
      timestamp: "2025-06-01T10:00:00.000Z",
      content: [
        { text: "Hi gemini, review this" },
        { functionResponse: { name: "read_file", response: { output: "TOOL BODY DROPPED" } } },
        { inlineData: { mimeType: "image/png", data: "BASE64BLOBDROPPED" } },
      ],
    },
    {
      id: "m2",
      type: "gemini",
      timestamp: "2025-06-01T10:00:05.000Z",
      content: "Sure, here's my review.",
      model: "gemini-2.5-pro",
      thoughts: [{ subject: "Planning", description: "SECRET THOUGHTS" }],
    },
    { id: "m3", type: "info", timestamp: "2025-06-01T10:00:06.000Z", content: "switched model" },
    { id: "m4", type: "error", timestamp: "2025-06-01T10:00:07.000Z", content: "quota exceeded" },
    // user message that is only tool noise → empty text → skipped
    {
      id: "m5",
      type: "user",
      timestamp: "2025-06-01T10:00:08.000Z",
      content: [{ functionResponse: { name: "shell" } }],
    },
    // legacy shape: plain string user content
    { id: "m6", type: "user", timestamp: "2025-06-01T10:00:09.000Z", content: "legacy string content" },
  ],
};

describe("geminiCliAdapter.parse", () => {
  it("parses a main session, keeping only the chat meat", async () => {
    const path = writeSession("hash1", "session-2025-06-01T10-00-abcd1234.json", MAIN_SESSION);
    writeFileSync(join(root, "hash1", ".project_root"), "/Users/x/myproj\n");

    const parsed = await geminiCliAdapter.parse(refFor(path));
    expect(parsed).not.toBeNull();
    const s = parsed!.session;

    // identity: filename stem, not the in-content sessionId
    expect(s.nativeId).toBe("session-2025-06-01T10-00-abcd1234");
    expect(s.agentSpecific?.contentSessionId).toBe("gem-content-session-id");
    expect(s.projectPath).toBe("/Users/x/myproj"); // from .project_root sibling
    expect(s.model).toBe("gemini-2.5-pro");
    expect(s.kind).toBeNull();

    // m1 (text part only), m2, m6 survive; info/error/m5 skipped
    expect(s.messages.map((m) => m.uid)).toEqual(["m1", "m2", "m6"]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(s.messages[0].text).toBe("Hi gemini, review this");
    expect(s.messages[1].text).toBe("Sure, here's my review.");
    expect(s.messages[2].text).toBe("legacy string content");

    const all = s.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain("TOOL BODY DROPPED");
    expect(all).not.toContain("BASE64BLOBDROPPED");
    expect(all).not.toContain("SECRET THOUGHTS");
    expect(all).not.toContain("quota exceeded");

    // timestamps from startTime / lastUpdated
    expect(s.createdAt).toBe(Date.parse("2025-06-01T10:00:00.000Z"));
    expect(s.updatedAt).toBe(Date.parse("2025-06-01T11:00:00.000Z"));
  });

  it("falls back to the message span when startTime/lastUpdated are absent", async () => {
    const path = writeSession("hash-fallback", "session-fallback.json", {
      messages: [
        { id: "m1", type: "user", timestamp: "2025-06-02T09:00:00.000Z", content: "first" },
        { id: "m2", type: "gemini", timestamp: "2025-06-02T09:30:00.000Z", content: "last" },
      ],
    });
    const parsed = await geminiCliAdapter.parse(refFor(path));
    expect(parsed!.session.createdAt).toBe(Date.parse("2025-06-02T09:00:00.000Z"));
    expect(parsed!.session.updatedAt).toBe(Date.parse("2025-06-02T09:30:00.000Z"));
    // no .project_root sibling → null project
    expect(parsed!.session.projectPath).toBeNull();
  });

  it("falls back to file mtime when there are no timestamps at all", async () => {
    const path = writeSession("hash-mtime", "session-mtime.json", {
      messages: [{ id: "m1", type: "user", content: "no clocks" }],
    });
    const parsed = await geminiCliAdapter.parse(refFor(path));
    const mtime = Math.floor(statSync(path).mtimeMs);
    expect(parsed!.session.createdAt).toBe(mtime);
    expect(parsed!.session.updatedAt).toBe(mtime);
  });

  it("returns null for subagent transcripts", async () => {
    const path = writeSession("hash-sub", "session-sub.json", {
      kind: "subagent",
      messages: [{ id: "m1", type: "user", content: "internal" }],
    });
    expect(await geminiCliAdapter.parse(refFor(path))).toBeNull();
  });

  it("returns null for corrupt or non-object JSON", async () => {
    const corrupt = writeSession("hash-bad", "session-corrupt.json", "{oops not json");
    expect(await geminiCliAdapter.parse(refFor(corrupt))).toBeNull();
    const scalar = writeSession("hash-bad", "session-scalar.json", "42");
    expect(await geminiCliAdapter.parse(refFor(scalar))).toBeNull();
  });
});

describe("geminiCliAdapter.enumerate", () => {
  it("finds only */chats/session-*.json under TROVE_GEMINI_ROOT", async () => {
    const enumRoot = mkdtempSync(join(tmpdir(), "trove-gem-enum-"));
    const prev = process.env.TROVE_GEMINI_ROOT;
    try {
      process.env.TROVE_GEMINI_ROOT = enumRoot;
      mkdirSync(join(enumRoot, "hashA", "chats"), { recursive: true });
      mkdirSync(join(enumRoot, "hashB", "chats"), { recursive: true });
      writeFileSync(join(enumRoot, "hashA", "chats", "session-1.json"), "{}");
      writeFileSync(join(enumRoot, "hashB", "chats", "session-2.json"), "{}");
      writeFileSync(join(enumRoot, "hashA", "chats", "other.json"), "{}"); // wrong prefix
      writeFileSync(join(enumRoot, "hashA", "session-top.json"), "{}"); // wrong depth
      writeFileSync(join(enumRoot, "hashA", ".project_root"), "/x");

      const refs = await geminiCliAdapter.enumerate();
      const names = refs.map((r) => r.path.slice(enumRoot.length + 1)).sort();
      expect(names).toEqual(["hashA/chats/session-1.json", "hashB/chats/session-2.json"]);
      for (const r of refs) {
        expect(r.agent).toBe("gemini-cli");
        expect(r.medium).toBe("file");
      }
    } finally {
      process.env.TROVE_GEMINI_ROOT = prev;
      rmSync(enumRoot, { recursive: true, force: true });
    }
  });

  it("returns [] when the root does not exist", async () => {
    const prev = process.env.TROVE_GEMINI_ROOT;
    try {
      process.env.TROVE_GEMINI_ROOT = join(tmpdir(), "trove-gem-definitely-missing");
      expect(await geminiCliAdapter.enumerate()).toEqual([]);
    } finally {
      process.env.TROVE_GEMINI_ROOT = prev;
    }
  });
});

describe("geminiCliAdapter.buildResumeCommand", () => {
  it("is unsupported (returns null)", () => {
    expect(geminiCliAdapter.buildResumeCommand!({ nativeId: "session-x" })).toBeNull();
  });
});
