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

    // identity: <project>/<stem> — NOT the bare stem (not unique across projects) and
    // NOT the in-content sessionId (shared across resumes/subagents)
    expect(s.nativeId).toBe("hash1/session-2025-06-01T10-00-abcd1234");
    expect(s.agentSpecific?.contentSessionId).toBe("gem-content-session-id");
    expect(s.projectPath).toBe("/Users/x/myproj"); // from .project_root sibling
    expect(s.model).toBe("gemini-2.5-pro");
    expect(s.kind).toBeNull();

    // m1 (text part only), m2, m4 (error → system), m6 survive; info/m5 skipped
    expect(s.messages.map((m) => m.uid)).toEqual(["m1", "m2", "m4", "m6"]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    expect(s.messages[0].text).toBe("Hi gemini, review this");
    expect(s.messages[1].text).toBe("Sure, here's my review.");
    expect(s.messages[2].text).toBe("quota exceeded"); // errors explain gaps — keep them
    expect(s.messages[3].text).toBe("legacy string content");

    const all = s.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain("TOOL BODY DROPPED");
    expect(all).not.toContain("BASE64BLOBDROPPED");
    expect(all).not.toContain("SECRET THOUGHTS");
    expect(all).not.toContain("switched model"); // info stays CLI noise

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
  it("returns null without a raw archive (slim copy can't round-trip)", () => {
    expect(geminiCliAdapter.buildResumeCommand!({ nativeId: "session-x" })).toBeNull();
    expect(
      geminiCliAdapter.buildResumeCommand!({ nativeId: "session-x", projectPath: "/p" }),
    ).toBeNull();
  });

  it("decompresses the raw archive to a temp file and resumes via --session-file", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      rawPath: "/Users/x/.trove/archive/gem.json.gz",
    })!;
    expect(cmd).toContain("RAW=$(mktemp /tmp/trove-resume-XXXXXX.json)");
    expect(cmd).toContain("gunzip -c '/Users/x/.trove/archive/gem.json.gz' > \"$RAW\"");
    expect(cmd).toContain('gemini --session-file "$RAW"');
    expect(cmd).not.toContain("cd "); // no project prefix when projectPath is absent
  });

  it("prefixes a cd into the project when projectPath is given (shell-quoted)", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      projectPath: "/Users/x/my proj",
      rawPath: "/a/b.json.gz",
    })!;
    expect(cmd.startsWith("cd '/Users/x/my proj' && ")).toBe(true);
    expect(cmd).toContain("gunzip -c '/a/b.json.gz'");
  });
});

// ── .jsonl mutation log (the current gemini format) ──────────────────────────
// gemini writes an append-only log; `.json` whole-documents are a pre-0.44 legacy that
// stores still contain, so both must parse. Record semantics mirror
// loadConversationRecord in the published @google/gemini-cli 0.44 bundle.

const HDR = (id: string) =>
  JSON.stringify({ sessionId: id, projectHash: "abc123", startTime: "2026-06-19T11:44:00.000Z", lastUpdated: "2026-06-19T11:50:00.000Z", kind: null });
const MSG = (id: string, type: "user" | "gemini", text: string) =>
  JSON.stringify(
    type === "user"
      ? { id, timestamp: "2026-06-19T11:44:01.000Z", type, content: [{ text }] }
      : { id, timestamp: "2026-06-19T11:44:09.000Z", type, content: text, thoughts: "hidden", model: "gemini-2.5-pro" },
  );

describe("gemini-cli .jsonl (0.44.x mutation log)", () => {
  it("enumerate() finds .jsonl sessions alongside .json", async () => {
    writeSession("h-mixed", "session-a.json", { sessionId: "a", messages: [] });
    writeSession("h-mixed", "session-b.jsonl", HDR("b"));
    const refs = await geminiCliAdapter.enumerate();
    const names = refs.map((r) => r.path.split("/").pop());
    expect(names).toContain("session-a.json");
    expect(names).toContain("session-b.jsonl");
  });

  it("replays header + per-line message records into a session", async () => {
    const p = writeSession("h-log", "session-log.jsonl", [HDR("s1"), MSG("m1", "user", "hello"), MSG("m2", "gemini", "hi there")].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r).not.toBeNull();
    expect(r!.session.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi there"],
    ]);
    // metadata from the header line survives the replay
    expect(r!.session.createdAt).toBe(Date.parse("2026-06-19T11:44:00.000Z"));
    expect(r!.session.model).toBe("gemini-2.5-pro");
  });

  it("strips the .jsonl extension from nativeId (and scopes it to the project)", async () => {
    const p = writeSession("h-nid", "session-2026-07-09T11-18-0d4f9f0a.jsonl", [HDR("s"), MSG("m1", "user", "x"), MSG("m2", "gemini", "y")].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.nativeId).toBe("h-nid/session-2026-07-09T11-18-0d4f9f0a");
  });

  it("a re-emitted id edits that message in place, keeping its position", async () => {
    const p = writeSession("h-edit", "session-edit.jsonl", [HDR("s"), MSG("m1", "user", "typo"), MSG("m2", "gemini", "reply"), MSG("m1", "user", "fixed")].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["fixed", "reply"]);
  });

  it("$set.messages replaces the whole history (the real 2-line work shape)", async () => {
    // Exactly what the work machine's files look like: a header, then one big $set.
    const setLine = JSON.stringify({
      $set: { lastUpdated: "2026-06-19T12:00:00.000Z", messages: [JSON.parse(MSG("x1", "user", "from set")), JSON.parse(MSG("x2", "gemini", "ok"))] },
    });
    const p = writeSession("h-set", "session-set.jsonl", [HDR("s"), MSG("gone", "user", "should be replaced"), setLine].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["from set", "ok"]);
  });

  it("$rewindTo drops that message and everything after it", async () => {
    const p = writeSession("h-rw", "session-rw.jsonl", [HDR("s"), MSG("m1", "user", "keep"), MSG("m2", "gemini", "drop me"), MSG("m3", "user", "drop me too"), JSON.stringify({ $rewindTo: "m2" }), MSG("m4", "gemini", "after rewind")].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["keep", "after rewind"]);
  });

  it("$rewindTo an unknown id clears the history entirely", async () => {
    const p = writeSession("h-rw2", "session-rw2.jsonl", [HDR("s"), MSG("m1", "user", "wiped"), JSON.stringify({ $rewindTo: "nope" }), MSG("m2", "user", "kept"), MSG("m3", "gemini", "kept too")].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["kept", "kept too"]);
  });

  it("survives a torn/corrupt trailing line rather than losing the session", async () => {
    const p = writeSession("h-torn", "session-torn.jsonl", [HDR("s"), MSG("m1", "user", "good"), MSG("m2", "gemini", "also good"), '{"id":"m3","type":"user",'].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["good", "also good"]);
  });
});

// ── identity: the filename stem is NOT unique ────────────────────────────────
// Real store (work laptop): 4 projects each held `session-2026-06-17T14-10-a2a-serv`,
// and one project held both a `.json` and a `.jsonl` of the same stem. Keying identity on
// the stem silently dropped ~32 sessions as "duplicate session id".
describe("gemini-cli session identity", () => {
  it("same stem in different projects yields DISTINCT sessions (a2a-serv collision)", async () => {
    const body = [HDR("s"), MSG("m1", "user", "hi"), MSG("m2", "gemini", "yo")].join("\n");
    const a = writeSession("atl", "session-2026-06-17T14-10-a2a-serv.jsonl", body);
    const b = writeSession("simulator", "session-2026-06-17T14-10-a2a-serv.jsonl", body);
    const ra = await geminiCliAdapter.parse(refFor(a));
    const rb = await geminiCliAdapter.parse(refFor(b));
    expect(ra!.session.nativeId).toBe("atl/session-2026-06-17T14-10-a2a-serv");
    expect(rb!.session.nativeId).toBe("simulator/session-2026-06-17T14-10-a2a-serv");
    expect(ra!.session.nativeId).not.toBe(rb!.session.nativeId); // the whole point
  });

  it("prefers the .jsonl when a legacy .json twin sits beside it", async () => {
    writeSession("twin", "session-2026-04-22T07-21-3ae2c125.json", { sessionId: "x", messages: [] });
    writeSession("twin", "session-2026-04-22T07-21-3ae2c125.jsonl", [HDR("x"), MSG("m1", "user", "live log")].join("\n"));
    const refs = await geminiCliAdapter.enumerate();
    const twins = refs.filter((r) => r.path.includes("/twin/"));
    expect(twins).toHaveLength(1); // not two — same conversation, two formats
    expect(twins[0].path.endsWith(".jsonl")).toBe(true);
  });

  it("keeps every same-stem session across projects when enumerating", async () => {
    const body = [HDR("s"), MSG("m1", "user", "hi"), MSG("m2", "gemini", "yo")].join("\n");
    for (const p of ["p-one", "p-two", "p-three"]) writeSession(p, "session-2026-06-18T07-12-a2a-serv.jsonl", body);
    const refs = await geminiCliAdapter.enumerate();
    const ids = new Set<string>();
    for (const r of refs.filter((x) => x.path.includes("a2a-serv") && /p-(one|two|three)/.test(x.path))) {
      const parsed = await geminiCliAdapter.parse(r);
      ids.add(parsed!.session.nativeId);
    }
    expect(ids.size).toBe(3); // three distinct ids → sync keeps all three
  });
});

// ── harness-injected environment preamble ────────────────────────────────────
// gemini-cli 0.44 unshifts a <session_context> block as a role:"user" message
// (getInitialChatHistory in the published bundle). It's the CLI talking to itself: it
// showed up as the human's opening line, and — worse — became the derived title, so every
// affected session looked identical in the list.
const SESSION_CTX = `<session_context>
This is the Gemini CLI. We are setting up the context for our chat.
Today's date is Monday, 14 July 2026 (formatted according to the user's locale).
My operating system is: linux
The project's temporary directory is: /home/m025699/.gemini/tmp/trove
Here is the folder structure of the current working directories:
/home/m025699/projects/apps/trove/
├── packages/
└── scripts/

Some memory from GEMINI.md
</session_context>`;

describe("gemini-cli synthetic <session_context>", () => {
  it("drops the injected preamble so the first REAL user turn leads", async () => {
    const p = writeSession("h-ctx", "session-ctx.jsonl", [
      HDR("s"),
      JSON.stringify({ id: "env", timestamp: "2026-07-14T12:29:00.000Z", type: "user", content: [{ text: SESSION_CTX }] }),
      MSG("m1", "user", "why does bun install 403 at work?"),
      MSG("m2", "gemini", "Because the registry blocks that version."),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "why does bun install 403 at work?"],
      ["assistant", "Because the registry blocks that version."],
    ]);
    // seq renumbers over KEPT messages, so the real turn is first
    expect(r!.session.messages[0].seq).toBe(0);
    // and nothing retains the junk
    expect(JSON.stringify(r!.session.messages)).not.toContain("session_context");
  });

  it("distinct sessions get distinct opening turns (the identical-titles bug)", async () => {
    // Same preamble, different real questions → the list must not show them as twins.
    const mk = (proj: string, q: string) =>
      writeSession(proj, "session-t.jsonl", [
        HDR("s"),
        JSON.stringify({ id: "env", type: "user", content: [{ text: SESSION_CTX }] }),
        MSG("m1", "user", q),
        MSG("m2", "gemini", "sure"),
      ].join("\n"));
    const a = await geminiCliAdapter.parse(refFor(mk("t-a", "how do I pin drizzle?")));
    const b = await geminiCliAdapter.parse(refFor(mk("t-b", "why is gemini empty in trove?")));
    // sync derives the title from the first user message — these must differ
    expect(a!.session.messages[0].text).toBe("how do I pin drizzle?");
    expect(b!.session.messages[0].text).toBe("why is gemini empty in trove?");
  });

  it("keeps a real message that merely mentions session_context in passing", async () => {
    const p = writeSession("h-ctx2", "session-ctx2.jsonl", [
      HDR("s"),
      MSG("m1", "user", "what is the <session_context> block for?"),
      MSG("m2", "gemini", "It's the environment preamble."),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // only a message STARTING with the tag is synthetic — this one is the human asking
    expect(r!.session.messages[0].text).toBe("what is the <session_context> block for?");
  });
});

// ── recorded tool calls on gemini turns ──────────────────────────────────────
// chatRecordingService (verified in the 0.44.1 bundle) records a tool-only model turn as
// `{...newMessage("gemini",""), toolCalls: [...]}` — content is the EMPTY STRING and the
// substance lives in toolCalls: [{id, name, displayName, description, args, result,
// status, ...}]. Dropping empty-text messages blindly erased every agentic assistant
// turn, so real sessions rendered as long runs of user messages with no replies.
describe("gemini-cli recorded toolCalls", () => {
  const TOOL_CALLS = [
    {
      id: "tc1",
      name: "run_shell_command",
      displayName: "Shell",
      description: "ls the repo",
      args: { command: "ls -la  \n  packages/" },
      result: [{ functionResponse: { name: "run_shell_command", response: { output: "HUGE TOOL OUTPUT" } } }],
      status: "success",
      renderOutputAsMarkdown: false,
    },
    {
      id: "tc2",
      name: "read_file",
      displayName: "ReadFile",
      args: { absolute_path: "/Users/x/proj/src/index.ts" },
      result: null,
      status: "error",
    },
    {
      id: "tc3",
      name: "replace",
      displayName: "Edit",
      args: {
        file_path: "/Users/x/proj/a.ts",
        old_string: "OLD BLOB NEVER CAPTURED",
        new_string: "NEW BLOB NEVER CAPTURED",
      },
      status: "cancelled",
    },
  ];

  it("keeps a tool-only gemini turn (content: \"\") as assistant + mapped toolCalls (.json)", async () => {
    const path = writeSession("h-tc", "session-tc.json", {
      sessionId: "s",
      messages: [
        { id: "u1", type: "user", timestamp: "2026-07-01T10:00:00.000Z", content: [{ text: "list the files" }] },
        { id: "g1", type: "gemini", timestamp: "2026-07-01T10:00:05.000Z", content: "", toolCalls: TOOL_CALLS, thoughts: [{ subject: "x" }], model: "gemini-2.5-pro" },
        { id: "g2", type: "gemini", timestamp: "2026-07-01T10:00:09.000Z", content: "Done, three files." },
      ],
    });
    const r = await geminiCliAdapter.parse(refFor(path));
    const s = r!.session;
    expect(s.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["g1", "assistant"], // kept despite empty text — the substance is the tool calls
      ["g2", "assistant"],
    ]);
    const g1 = s.messages[1];
    expect(g1.text).toBe("");
    expect(g1.toolCalls).toEqual([
      { name: "Shell", input: "ls -la packages/" }, // displayName preferred; command compacted
      { name: "ReadFile", input: "/Users/x/proj/src/index.ts" },
      { name: "Edit", input: "/Users/x/proj/a.ts" },
    ]);
    // blob args and result bodies never leak into the compact records
    const json = JSON.stringify(s.messages);
    expect(json).not.toContain("OLD BLOB");
    expect(json).not.toContain("NEW BLOB");
    expect(json).not.toContain("HUGE TOOL OUTPUT");
    // the prose-only turn carries no toolCalls field
    expect(s.messages[2].toolCalls).toBeUndefined();
  });

  it("maps toolCalls on a .jsonl mutation-log session too (same parse path)", async () => {
    const toolMsg = JSON.stringify({
      id: "g1",
      timestamp: "2026-07-01T11:00:05.000Z",
      type: "gemini",
      content: "",
      toolCalls: [TOOL_CALLS[0]],
      model: "gemini-2.5-pro",
    });
    const p = writeSession("h-tcl", "session-tcl.jsonl", [HDR("s"), MSG("m1", "user", "run ls"), toolMsg].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "Shell", input: "ls -la packages/" }]);
  });

  it("keeps toolCalls that ride along WITH prose on the same gemini turn", async () => {
    const p = writeSession("h-tcp", "session-tcp.jsonl", [
      HDR("s"),
      MSG("m1", "user", "check it"),
      JSON.stringify({ id: "g1", type: "gemini", content: "Looking now.", toolCalls: [TOOL_CALLS[1]] }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages[1].text).toBe("Looking now.");
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "ReadFile", input: "/Users/x/proj/src/index.ts" }]);
  });

  it("degrades gracefully on missing/garbage toolCall fields (untrusted input)", async () => {
    const p = writeSession("h-tcg", "session-tcg.jsonl", [
      HDR("s"),
      JSON.stringify({
        id: "g1",
        type: "gemini",
        content: "",
        toolCalls: [
          null, // garbage entry → skipped
          "not an object", // garbage entry → skipped
          { args: { command: "x" } }, // no name at all → skipped
          { name: "read_file", args: { absolute_path: "/a/b.ts" } }, // no displayName → falls back to name
          { name: "google_web_search", displayName: "  ", args: { query: "bun 403" } }, // blank displayName → name
          { name: "mystery_tool", displayName: "Mystery", args: 42 }, // non-object args → name-only
          { name: "odd_tool", args: { weird_key: { nested: true } } }, // no useful scalar key → name-only
        ],
      }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages).toHaveLength(1);
    expect(r!.session.messages[0].toolCalls).toEqual([
      { name: "read_file", input: "/a/b.ts" },
      { name: "google_web_search", input: "bun 403" },
      { name: "Mystery", input: "" },
      { name: "odd_tool", input: "" },
    ]);
  });

  it("toolCalls that is not an array is ignored, so the empty turn stays dropped", async () => {
    const p = writeSession("h-tcn", "session-tcn.jsonl", [
      HDR("s"),
      MSG("m1", "user", "hi"),
      JSON.stringify({ id: "g1", type: "gemini", content: "", toolCalls: { sneaky: "object" } }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1"]);
  });

  it("still drops a thought-only gemini turn (empty content, no toolCalls)", async () => {
    const p = writeSession("h-thought", "session-thought.jsonl", [
      HDR("s"),
      MSG("m1", "user", "hmm"),
      JSON.stringify({ id: "g1", type: "gemini", content: "", thoughts: [{ subject: "SECRET" }] }),
      MSG("m2", "gemini", "actual reply"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1", "m2"]);
    expect(JSON.stringify(r!.session.messages)).not.toContain("SECRET");
  });

  it("still drops a user message with only functionResponse parts (.jsonl path)", async () => {
    const p = writeSession("h-fr", "session-fr.jsonl", [
      HDR("s"),
      MSG("m1", "user", "go"),
      JSON.stringify({ id: "m2", type: "user", content: [{ functionResponse: { name: "shell", response: { output: "TOOL BODY" } } }] }),
      MSG("m3", "gemini", "done"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1", "m3"]);
  });
});

// ── error records → system messages ──────────────────────────────────────────
// `type: "error"` records carry the reason a conversation broke (quota, 4xx …); keep
// them as muted system rows so the gap is explained. `type: "info"` stays dropped.
describe("gemini-cli error records", () => {
  it("maps an error record to a system message with the error text (.jsonl)", async () => {
    const p = writeSession("h-err", "session-err.jsonl", [
      HDR("s"),
      MSG("m1", "user", "keep going"),
      JSON.stringify({ id: "e1", timestamp: "2026-07-01T12:00:00.000Z", type: "error", content: "Quota exceeded for gemini-2.5-pro" }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "keep going"],
      ["system", "Quota exceeded for gemini-2.5-pro"],
    ]);
  });

  it("skips error records whose content is empty or not a string", async () => {
    const p = writeSession("h-err2", "session-err2.jsonl", [
      HDR("s"),
      MSG("m1", "user", "hi"),
      JSON.stringify({ id: "e1", type: "error", content: "" }),
      JSON.stringify({ id: "e2", type: "error", content: { code: 429 } }),
      JSON.stringify({ id: "e3", type: "error" }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1"]);
  });

  it("still skips info records", async () => {
    const p = writeSession("h-info", "session-info.jsonl", [
      HDR("s"),
      MSG("m1", "user", "hi"),
      JSON.stringify({ id: "i1", type: "info", content: "switched to gemini-2.5-flash" }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1"]);
  });
});
