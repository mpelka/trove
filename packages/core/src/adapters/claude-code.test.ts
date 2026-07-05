import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeAdapter } from "./claude-code.ts";
import type { SourceRef } from "./types.ts";

let root: string;
const OLD_ROOT = process.env.TROVE_CC_ROOT;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trove-cc-"));
  process.env.TROVE_CC_ROOT = root;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (OLD_ROOT === undefined) delete process.env.TROVE_CC_ROOT;
  else process.env.TROVE_CC_ROOT = OLD_ROOT;
});

function writeFixture(relPath: string, lines: unknown[]): string {
  const path = join(root, relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  writeFileSync(path, body + "\n");
  return path;
}

function refFor(path: string): SourceRef {
  const st = statSync(path);
  return {
    agent: "claude-code",
    medium: "file",
    path,
    sizeBytes: st.size,
    mtimeMs: Math.floor(st.mtimeMs),
  };
}

const NATIVE_ID = "7de4a1b2-1111-2222-3333-444455556666";

const MAIN_LINES: unknown[] = [
  { type: "summary", summary: "Fixing the sync bug" },
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2025-06-01T10:00:00.000Z",
    sessionId: "content-session-id",
    cwd: "/Users/x/proj",
    message: { role: "user", content: "Hello, please fix the bug" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2025-06-01T10:00:05.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [
        { type: "thinking", thinking: "SECRET reasoning that must be dropped" },
        { type: "text", text: "Here is the fix:\n\n```ts\nconst x = 1;\n```" },
        { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
      ],
    },
  },
  // tool_result-only user entry → no text extracted → skipped entirely
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2025-06-01T10:00:07.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "HUGE TOOL OUTPUT that must be dropped" }],
    },
  },
  // assistant with only tool_use blocks → compact "[used: …]" marker, role "tool"
  {
    type: "assistant",
    uuid: "a2",
    parentUuid: "u2",
    timestamp: "2025-06-01T10:00:10.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Bash" },
        { type: "tool_use", name: "Read" },
      ],
    },
  },
  // image-only user entry → dropped
  {
    type: "user",
    uuid: "u3",
    parentUuid: "a2",
    timestamp: "2025-06-01T10:00:12.000Z",
    message: { role: "user", content: [{ type: "image", source: { data: "base64stuff" } }] },
  },
  "{this is not valid json", // bad line → skipped, no throw
  {
    type: "user",
    uuid: "u4",
    parentUuid: "a2",
    timestamp: "2025-06-01T10:00:20.000Z",
    message: { role: "user", content: "Thanks, looks good" },
  },
];

describe("claudeCodeAdapter.parse", () => {
  it("extracts the slim conversation from a JSONL fixture", async () => {
    const path = writeFixture(`proj/${NATIVE_ID}.jsonl`, MAIN_LINES);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    expect(parsed).not.toBeNull();
    const s = parsed!.session;

    // identity: filename stem, NOT the in-content sessionId
    expect(s.nativeId).toBe(NATIVE_ID);
    expect(s.agentSpecific?.contentSessionId).toBe("content-session-id");
    expect(s.projectPath).toBe("/Users/x/proj");
    expect(s.model).toBe("claude-opus-4");
    expect(s.sourceTitle).toBe("Fixing the sync bug");

    // u1, a1, a2(tool marker), u4 survive; u2 (tool_result), u3 (image) dropped
    expect(s.messages.map((m) => m.uid)).toEqual(["u1", "a1", "a2", "u4"]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);

    const a1 = s.messages[1];
    expect(a1.text).toContain("const x = 1;"); // code kept
    expect(a1.text).not.toContain("SECRET"); // thinking dropped
    expect(a1.parentUid).toBe("u1");
    expect(a1.timestamp).toBe(Date.parse("2025-06-01T10:00:05.000Z"));

    // tool_use-only turn → deduped marker, first-seen order
    expect(s.messages[2].text).toBe("[used: Read, Bash]");

    // nothing from dropped bodies leaks through
    const all = s.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain("HUGE TOOL OUTPUT");
    expect(all).not.toContain("base64stuff");

    // session time span from message timestamps
    expect(s.createdAt).toBe(Date.parse("2025-06-01T10:00:00.000Z"));
    expect(s.updatedAt).toBe(Date.parse("2025-06-01T10:00:20.000Z"));

    expect(parsed!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures compact per-tool_use toolCalls, truncating Bash and excluding blobs", async () => {
    const longCmd = "echo " + "x".repeat(700); // > 500 → truncated
    const path = writeFixture("proj/toolcalls-session.jsonl", [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2025-06-01T10:00:00.000Z",
        message: { role: "user", content: "do stuff" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2025-06-01T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: longCmd, description: "run it" } },
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: "src/foo.ts",
                old_string: "HUGE OLD BLOB ".repeat(500),
                new_string: "HUGE NEW BLOB ".repeat(500),
              },
            },
            { type: "tool_use", name: "Read", input: { file_path: "src/bar.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "git status" } },
          ],
        },
      },
    ]);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    const tool = parsed!.session.messages.find((m) => m.role === "tool")!;

    // text summary stays deduped/first-seen for back-compat.
    expect(tool.text).toBe("[used: Bash, Edit, Read]");

    // toolCalls: one entry PER tool_use, in order (NOT deduped).
    expect(tool.toolCalls?.map((c) => c.name)).toEqual(["Bash", "Edit", "Read", "Bash"]);

    // Bash command captured, truncated to ~500 chars, ends with an ellipsis; blob 'description' ignored.
    const bash0 = tool.toolCalls![0];
    expect(bash0.name).toBe("Bash");
    expect(bash0.input.startsWith("echo xxx")).toBe(true);
    expect(bash0.input.length).toBeLessThanOrEqual(500);
    expect(bash0.input.endsWith("…")).toBe(true);

    // Edit → file_path only; large old_string/new_string blobs are NOT present anywhere.
    expect(tool.toolCalls![1]).toEqual({ name: "Edit", input: "src/foo.ts" });
    expect(tool.toolCalls![2]).toEqual({ name: "Read", input: "src/bar.ts" });
    expect(tool.toolCalls![3]).toEqual({ name: "Bash", input: "git status" });

    const serialized = JSON.stringify(tool.toolCalls);
    expect(serialized).not.toContain("HUGE OLD BLOB");
    expect(serialized).not.toContain("HUGE NEW BLOB");
  });

  it("uses customTitle when no summary line exists", async () => {
    const path = writeFixture("proj/custom-title-session.jsonl", [
      { type: "file-history-snapshot", customTitle: "My Custom Name" },
      {
        type: "user",
        uuid: "u1",
        timestamp: "2025-06-01T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
    ]);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    expect(parsed!.session.sourceTitle).toBe("My Custom Name");
  });

  it("drops every synthetic pseudo-user turn variant", async () => {
    const synthetic = [
      "<task-notification>done</task-notification>",
      "<system-reminder>reminder</system-reminder>",
      "<local-command-caveat>caveat</local-command-caveat>",
      "<local-command-stdout>out</local-command-stdout>",
      "<local-command-stderr>err</local-command-stderr>",
      "<command-name>/foo</command-name>",
      "<command-message>foo</command-message>",
      "<command-args>bar</command-args>",
      "<bash-input>ls</bash-input>",
      "<bash-stdout>files</bash-stdout>",
      "<bash-stderr>oops</bash-stderr>",
      "<user-prompt-submit-hook>hook</user-prompt-submit-hook>",
      "Caveat: The messages below were generated by the user while running local commands.",
      "  <system-reminder>leading whitespace still synthetic</system-reminder>",
    ];
    const lines: unknown[] = synthetic.map((content, i) => ({
      type: "user",
      uuid: `syn${i}`,
      timestamp: "2025-06-01T10:00:00.000Z",
      message: { role: "user", content },
    }));
    lines.push({
      type: "user",
      uuid: "real",
      timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "user", content: "a genuine human message" },
    });
    const path = writeFixture("proj/synthetic-session.jsonl", lines);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    expect(parsed!.session.messages).toHaveLength(1);
    expect(parsed!.session.messages[0].uid).toBe("real");
  });

  it("keeps synthetic-looking text when the role is assistant", async () => {
    const path = writeFixture("proj/assistant-reminder.jsonl", [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2025-06-01T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<system-reminder> is a tag I noticed" }],
        },
      },
    ]);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    expect(parsed!.session.messages).toHaveLength(1);
    expect(parsed!.session.messages[0].role).toBe("assistant");
  });

  it("falls back to file mtime when no message has a timestamp", async () => {
    const path = writeFixture("proj/no-ts.jsonl", [
      { type: "user", uuid: "u1", message: { role: "user", content: "no timestamp here" } },
    ]);
    const parsed = await claudeCodeAdapter.parse(refFor(path));
    const mtime = Math.floor(statSync(path).mtimeMs);
    expect(parsed!.session.createdAt).toBe(mtime);
    expect(parsed!.session.updatedAt).toBe(mtime);
    expect(parsed!.session.messages[0].timestamp).toBeNull();
  });
});

describe("claudeCodeAdapter.enumerate", () => {
  it("finds *.jsonl but skips subagents, agent-*.jsonl and journal.jsonl", async () => {
    const enumRoot = mkdtempSync(join(tmpdir(), "trove-cc-enum-"));
    const prev = process.env.TROVE_CC_ROOT;
    try {
      process.env.TROVE_CC_ROOT = enumRoot;
      mkdirSync(join(enumRoot, "projA", "sess1", "subagents"), { recursive: true });
      writeFileSync(join(enumRoot, "projA", "keep-one.jsonl"), "{}\n");
      writeFileSync(join(enumRoot, "projA", "keep-two.jsonl"), "{}\n");
      writeFileSync(join(enumRoot, "projA", "journal.jsonl"), "{}\n");
      writeFileSync(join(enumRoot, "projA", "agent-sub.jsonl"), "{}\n");
      writeFileSync(join(enumRoot, "projA", "sess1", "subagents", "agent-x.jsonl"), "{}\n");
      writeFileSync(join(enumRoot, "projA", "notes.txt"), "not jsonl\n");

      const refs = await claudeCodeAdapter.enumerate();
      const names = refs.map((r) => r.path.slice(enumRoot.length + 1)).sort();
      expect(names).toEqual(["projA/keep-one.jsonl", "projA/keep-two.jsonl"]);
      for (const r of refs) {
        expect(r.agent).toBe("claude-code");
        expect(r.medium).toBe("file");
        expect(r.sizeBytes).toBeGreaterThan(0);
        expect(r.mtimeMs).toBeGreaterThan(0);
      }
    } finally {
      process.env.TROVE_CC_ROOT = prev;
      rmSync(enumRoot, { recursive: true, force: true });
    }
  });

  it("returns [] when the root does not exist", async () => {
    const prev = process.env.TROVE_CC_ROOT;
    try {
      process.env.TROVE_CC_ROOT = join(tmpdir(), "trove-cc-definitely-missing");
      expect(await claudeCodeAdapter.enumerate()).toEqual([]);
    } finally {
      process.env.TROVE_CC_ROOT = prev;
    }
  });
});

describe("claudeCodeAdapter.buildResumeCommand", () => {
  it("builds a cd + resume command, shell-quoting the project path", () => {
    const cmd = claudeCodeAdapter.buildResumeCommand!({
      nativeId: "abc-123",
      projectPath: "/Users/x/it's here",
    });
    expect(cmd).toBe(`cd '/Users/x/it'\\''s here' && claude --resume abc-123`);
  });

  it("omits cd without a project path and returns null without a nativeId", () => {
    expect(
      claudeCodeAdapter.buildResumeCommand!({ nativeId: "abc-123", projectPath: null }),
    ).toBe("claude --resume abc-123");
    expect(claudeCodeAdapter.buildResumeCommand!({ nativeId: "" })).toBeNull();
  });
});
