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
    // user message that is only a functionResponse → surfaced as a tool row (the response
    // side is sometimes the ONLY persisted trace of tool use — see the tool-row describe)
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

    // m1 (text part only), m2, m4 (error → system), m5 (functionResponse → tool row),
    // m6 survive; info skipped
    expect(s.messages.map((m) => m.uid)).toEqual(["m1", "m2", "m4", "m5", "m6"]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "tool", "user"]);
    expect(s.messages[0].text).toBe("Hi gemini, review this");
    expect(s.messages[1].text).toBe("Sure, here's my review.");
    expect(s.messages[2].text).toBe("quota exceeded"); // errors explain gaps — keep them
    expect(s.messages[3].text).toBe("[used: shell]"); // name-only chip, no response body
    expect(s.messages[3].toolCalls).toEqual([{ name: "shell", input: "" }]);
    expect(s.messages[4].text).toBe("legacy string content");

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
  it("returns null with nothing usable to resume from", () => {
    expect(geminiCliAdapter.buildResumeCommand!({ nativeId: "session-x" })).toBeNull();
    expect(
      geminiCliAdapter.buildResumeCommand!({ nativeId: "session-x", projectPath: "/p" }),
    ).toBeNull();
  });

  it("prefers a true `--resume <sessionId>` in the project (the id gemini matches)", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "proj/session-x",
      projectPath: "/Users/x/my proj",
      sourcePath: "/Users/x/.gemini/tmp/proj/chats/session-x.jsonl", // present, but --resume wins
      agentSpecific: { contentSessionId: "d1d13625-1c51-4eb7-9d57" },
    })!;
    expect(cmd).toBe("cd '/Users/x/my proj' && gemini --resume 'd1d13625-1c51-4eb7-9d57'");
    expect(cmd).not.toContain("session-file");
  });

  it("falls back to --session-file (import) when there's no sessionId", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      projectPath: "/Users/x/my proj",
      sourcePath: "/Users/x/.gemini/tmp/proj/chats/session-x.jsonl",
    })!;
    expect(cmd).toBe(
      "cd '/Users/x/my proj' && gemini --session-file '/Users/x/.gemini/tmp/proj/chats/session-x.jsonl'",
    );
    expect(cmd).not.toContain("gunzip");
  });

  it("uses --session-file (not --resume) when there's an id but no project to cd into", () => {
    // --resume only searches the current project's chats, so without a project we can't
    // safely emit it; the live source works from anywhere.
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      sourcePath: "/s/session-x.jsonl",
      agentSpecific: { contentSessionId: "abc-123" },
    })!;
    expect(cmd).toBe("gemini --session-file '/s/session-x.jsonl'");
  });

  it("falls back to the gunzip dance when the source is gone but an archive was kept", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      projectPath: "/Users/x/my proj",
      sourceGone: true, // live file vanished
      rawPath: "/a/b.jsonl.gz",
    })!;
    expect(cmd.startsWith("cd '/Users/x/my proj' && ")).toBe(true);
    expect(cmd).toContain("RAW=$(mktemp /tmp/trove-resume-XXXXXX.jsonl)");
    expect(cmd).toContain("gunzip -c '/a/b.jsonl.gz' > \"$RAW\"");
    expect(cmd).toContain('gemini --session-file "$RAW"');
  });

  it("prefers --resume even when the source is gone (the id still resolves in-project)", () => {
    const cmd = geminiCliAdapter.buildResumeCommand!({
      nativeId: "session-x",
      projectPath: "/p",
      sourceGone: true,
      rawPath: "/a/b.jsonl.gz",
      agentSpecific: { contentSessionId: "keeps-working" },
    })!;
    expect(cmd).toBe("cd '/p' && gemini --resume 'keeps-working'");
  });

  it("returns null when the source is gone and no archive or id is available", () => {
    expect(
      geminiCliAdapter.buildResumeCommand!({
        nativeId: "session-x",
        projectPath: "/p",
        sourceGone: true,
      }),
    ).toBeNull();
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

  it("$set.messages MERGES by id — accumulated messages absent from the reseed survive", async () => {
    // The work-machine shape: a header, then one big $set (a reseed). The reseed reflects
    // the MODEL's memory, not the log's history — replaying it as clear+seed implemented
    // the vendor's amnesia and ate every pre-compaction turn. Merge semantics: absent ids
    // survive in place, seeded ids upsert, new ids append.
    const setLine = JSON.stringify({
      $set: { lastUpdated: "2026-06-19T12:00:00.000Z", messages: [JSON.parse(MSG("x1", "user", "from set")), JSON.parse(MSG("x2", "gemini", "ok"))] },
    });
    const p = writeSession("h-set", "session-set.jsonl", [HDR("s"), MSG("kept", "user", "not in the reseed"), setLine].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.text)).toEqual(["not in the reseed", "from set", "ok"]);
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

  it("surfaces a functionResponse-only user message as a tool row, never its body (.jsonl path)", async () => {
    const p = writeSession("h-fr", "session-fr.jsonl", [
      HDR("s"),
      MSG("m1", "user", "go"),
      JSON.stringify({ id: "m2", type: "user", content: [{ functionResponse: { name: "shell", response: { output: "TOOL BODY" } } }] }),
      MSG("m3", "gemini", "done"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["m1", "user"],
      ["m2", "tool"],
      ["m3", "assistant"],
    ]);
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "shell", input: "" }]);
    expect(JSON.stringify(r!.session.messages)).not.toContain("TOOL BODY");
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

// ── harness-injected turns from a REAL 0.44.1 agentic .jsonl (work machine) ──
// Observed on-disk: gemini's compression/resume artifact (<state_snapshot>) and the CLI's
// workspace announcement both arrive as type:"user" records; the CALL side of tool use was
// never persisted (gemini turns carry only thoughts, NO toolCalls field), so the
// functionResponse parts on user-type records are the only trace tools ran. Pre-fix the
// session rendered as "me, me, me, me, gemini" with zero tool calls.
const STATE_SNAPSHOT = `<state_snapshot>
## Conversation so far
The user asked about the failing sync; we inspected packages/core and found the bug.
</state_snapshot>`;

const WORKSPACE_MSG =
  "- **Workspace Directories:**\n  - /home/m025699/projects/apps/trove\n- **Today:** 2026-07-15";

describe("gemini-cli <state_snapshot> and workspace announcements", () => {
  it("turns a <state_snapshot> user message into a system row, text preserved", async () => {
    const p = writeSession("h-snap", "session-snap.jsonl", [
      HDR("s"),
      JSON.stringify({ id: "snap", type: "user", timestamp: "2026-07-15T09:00:00.000Z", content: [{ text: STATE_SNAPSHOT }] }),
      MSG("m1", "user", "carry on from there"),
      MSG("m2", "gemini", "Picking up where we left off."),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["snap", "system"], // informative but not the human — muted row, NOT dropped
      ["m1", "user"],
      ["m2", "assistant"],
    ]);
    expect(r!.session.messages[0].text).toBe(STATE_SNAPSHOT); // summary text kept
  });

  it("drops the workspace-directories announcement as synthetic (.jsonl)", async () => {
    const p = writeSession("h-ws", "session-ws.jsonl", [
      HDR("s"),
      JSON.stringify({ id: "ws", type: "user", content: [{ text: WORKSPACE_MSG }] }),
      MSG("m1", "user", "real question"),
      MSG("m2", "gemini", "real answer"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["m1", "m2"]);
    expect(JSON.stringify(r!.session.messages)).not.toContain("Workspace Directories");
  });

  it("keeps a real message that merely MENTIONS workspace directories mid-text", async () => {
    const p = writeSession("h-ws2", "session-ws2.jsonl", [
      HDR("s"),
      MSG("m1", "user", "why are the - **Workspace Directories:** wrong in trove?"),
      MSG("m2", "gemini", "because…"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // only a message STARTING with the marker is synthetic
    expect(r!.session.messages[0].text).toBe("why are the - **Workspace Directories:** wrong in trove?");
  });
});

// ── functionResponse-derived tool rows + dedup against recorded toolCalls ────
describe("gemini-cli functionResponse tool rows", () => {
  const FR = (id: string | null, name: string) =>
    ({ functionResponse: { ...(id ? { id } : {}), name, response: { output: "NEVER CAPTURED OUTPUT" } } });

  it("maps a functionResponse-only user message to role tool with name-only chips (.json)", async () => {
    const path = writeSession("h-frj", "session-frj.json", {
      sessionId: "s",
      messages: [
        { id: "u1", type: "user", timestamp: "2026-07-15T10:00:00.000Z", content: [{ text: "find the globs" }] },
        // two responses in ONE message → two entries, order kept
        { id: "u2", type: "user", timestamp: "2026-07-15T10:00:05.000Z", content: [FR("glob__glob_1783939161358_0", "glob"), FR("read__1", "read_file")] },
        { id: "g1", type: "gemini", timestamp: "2026-07-15T10:00:09.000Z", content: "Found them." },
      ],
    });
    const r = await geminiCliAdapter.parse(refFor(path));
    const s = r!.session;
    expect(s.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["u2", "tool"],
      ["g1", "assistant"],
    ]);
    expect(s.messages[1].toolCalls).toEqual([
      { name: "glob", input: "" },
      { name: "read_file", input: "" },
    ]);
    expect(s.messages[1].text).toBe("[used: glob, read_file]"); // buildItems derives counts from this
    expect(JSON.stringify(s.messages)).not.toContain("NEVER CAPTURED OUTPUT"); // blob-safety
  });

  it("mixed content (typed text + functionResponse part) stays a normal user message", async () => {
    const p = writeSession("h-frmix", "session-frmix.jsonl", [
      HDR("s"),
      JSON.stringify({ id: "u1", type: "user", content: [{ text: "here's the result, now explain it" }, FR("x1", "shell")] }),
      MSG("g1", "gemini", "sure"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // text wins — don't reclassify the human
    expect(r!.session.messages[0].role).toBe("user");
    expect(r!.session.messages[0].text).toBe("here's the result, now explain it");
    expect(r!.session.messages[0].toolCalls).toBeUndefined();
  });

  it("dedups functionResponses whose id was recorded in a gemini toolCalls entry", async () => {
    const p = writeSession("h-frdedup", "session-frdedup.jsonl", [
      HDR("s"),
      MSG("u1", "user", "go"),
      // the call side WAS recorded here (id tcX) …
      JSON.stringify({ id: "g1", type: "gemini", content: "", toolCalls: [{ id: "tcX", name: "run_shell_command", displayName: "Shell", args: { command: "ls" } }] }),
      // … so its functionResponse must NOT synthesize a second row; the unknown id tcY must
      JSON.stringify({ id: "u2", type: "user", content: [FR("tcX", "run_shell_command"), FR("tcY", "glob")] }),
      MSG("g2", "gemini", "done"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["g1", "assistant"], // the recorded call renders here…
      ["u2", "tool"], // …and the tool row carries ONLY the unrecorded one
      ["g2", "assistant"],
    ]);
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "Shell", input: "ls" }]);
    expect(r!.session.messages[2].toolCalls).toEqual([{ name: "glob", input: "" }]);
  });

  it("dedups even when the recorded toolCalls appear AFTER the functionResponse (replay order)", async () => {
    const p = writeSession("h-frlate", "session-frlate.jsonl", [
      HDR("s"),
      MSG("u1", "user", "go"),
      JSON.stringify({ id: "u2", type: "user", content: [FR("tcZ", "read_file")] }),
      JSON.stringify({ id: "g1", type: "gemini", content: "read it", toolCalls: [{ id: "tcZ", name: "read_file", args: { absolute_path: "/a.ts" } }] }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // the pre-pass sees tcZ before the main loop, so u2 fully dedups away
    expect(r!.session.messages.map((m) => m.uid)).toEqual(["u1", "g1"]);
  });

  it("synthesizes an id-less functionResponse (fail toward showing the tool)", async () => {
    const p = writeSession("h-frnoid", "session-frnoid.jsonl", [
      HDR("s"),
      MSG("u1", "user", "go"),
      JSON.stringify({ id: "g1", type: "gemini", content: "", toolCalls: [{ id: "tc1", name: "shell", args: {} }] }),
      JSON.stringify({ id: "u2", type: "user", content: [FR(null, "shell")] }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // no id → dedup is best-effort → still shown, even though it may be tc1's response
    expect(r!.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(r!.session.messages[2].toolCalls).toEqual([{ name: "shell", input: "" }]);
  });

  it("replays the full observed work-machine stream into system/user/tool/assistant", async () => {
    // The exact record shapes seen on screen in the real 0.44.1 log: snapshot + workspace
    // as fake users, thought-only gemini turns with NO toolCalls field, functionResponse
    // users as the only tool trace, then real assistant text.
    const p = writeSession("h-real", "session-real.jsonl", [
      HDR("s"),
      JSON.stringify({ id: "snap", type: "user", content: [{ text: STATE_SNAPSHOT }] }),
      JSON.stringify({ id: "ws", type: "user", content: [{ text: WORKSPACE_MSG }] }),
      MSG("u1", "user", "where do the session files live?"),
      JSON.stringify({ id: "g1", type: "gemini", content: "", thoughts: [{ subject: "Searching", description: "HIDDEN" }] }),
      JSON.stringify({ id: "u2", type: "user", content: [FR("glob__glob_1783939161358_0", "glob")] }),
      JSON.stringify({ id: "g2", type: "gemini", content: "", thoughts: [{ subject: "Reading", description: "HIDDEN" }] }),
      JSON.stringify({ id: "u3", type: "user", content: [FR("read__2", "read_file")] }),
      MSG("g3", "gemini", "They live under ~/.gemini/tmp."),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // pre-fix this was user,user,user,user,assistant ("me me me") with zero tools
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["snap", "system"],
      ["u1", "user"],
      ["u2", "tool"],
      ["u3", "tool"],
      ["g3", "assistant"],
    ]);
    expect(r!.session.messages[2].toolCalls).toEqual([{ name: "glob", input: "" }]);
    expect(r!.session.messages[3].toolCalls).toEqual([{ name: "read_file", input: "" }]);
    const json = JSON.stringify(r!.session.messages);
    expect(json).not.toContain("HIDDEN");
    expect(json).not.toContain("Workspace Directories");
  });
});

// ── compaction reseeds ($set.messages) + parts-array gemini content ──────────
// chatRecordingService.updateMessagesFromHistory (verified in the 0.44.1 bundle) runs
// after rewind and after COMPACTION: it rebuilds the message list from the MODEL's
// in-memory history and emits one `$set:{messages:[…]}` record. Two traps for an archive:
//   1. every surviving gemini message's `content` becomes the API PARTS ARRAY
//      (`{...existing, content: turn.content.parts || []}`) — a string no more;
//   2. turns compressed away are absent from the array even though their records still
//      sit EARLIER in the same file.
// Pre-fix, trove replayed the reseed as clear+seed and parsed array content as "" — on
// the real work store 20+ sessions were affected, the worst losing 6000+ message-states,
// all rendering as runs of user messages with tool strips and no answers.
describe("gemini-cli reseed ($set.messages merge) and parts-array content", () => {
  const FR = (id: string | null, name: string) =>
    ({ functionResponse: { ...(id ? { id } : {}), name, response: { output: "NEVER CAPTURED" } } });

  it("extracts text from a gemini message whose content is a parts ARRAY, skipping thoughts", async () => {
    const p = writeSession("h-parts", "session-parts.jsonl", [
      HDR("s"),
      MSG("u1", "user", "explain"),
      JSON.stringify({
        id: "g1", type: "gemini", timestamp: "2026-06-19T11:44:09.000Z", model: "gemini-2.5-pro",
        content: [
          { thought: true, text: "SECRET REASONING" }, // truthy thought flag → reasoning, dropped
          { text: "First paragraph." },
          { text: "Second paragraph." },
        ],
      }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r!.session.messages[1].text).toBe("First paragraph.\n\nSecond paragraph."); // joined like extractUserText
    expect(JSON.stringify(r!.session.messages)).not.toContain("SECRET REASONING");
  });

  it("maps functionCall parts to toolCalls with toolInput conventions (no blob capture)", async () => {
    const p = writeSession("h-fc", "session-fc.jsonl", [
      HDR("s"),
      MSG("u1", "user", "run it"),
      JSON.stringify({
        id: "g1", type: "gemini",
        content: [
          { text: "Running it now." },
          { functionCall: { id: "fc1", name: "run_shell_command", args: { command: "ls   -la\npackages/" } } },
          { functionCall: { id: "fc2", name: "replace", args: { file_path: "/a.ts", old_string: "OLD BLOB", new_string: "NEW BLOB" } } },
          { functionCall: { name: "  " } }, // blank name → skipped
          { functionCall: "garbage" }, // not an object → skipped
        ],
      }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    const g1 = r!.session.messages[1];
    expect(g1.role).toBe("assistant");
    expect(g1.text).toBe("Running it now.");
    expect(g1.toolCalls).toEqual([
      { name: "run_shell_command", input: "ls -la packages/" }, // command compacted
      { name: "replace", input: "/a.ts" }, // blob args never captured
    ]);
    const json = JSON.stringify(r!.session.messages);
    expect(json).not.toContain("OLD BLOB");
    expect(json).not.toContain("NEW BLOB");
  });

  it("merges functionCall parts with recorded toolCalls; recorded wins on id collision", async () => {
    const p = writeSession("h-fcmix", "session-fcmix.jsonl", [
      HDR("s"),
      MSG("u1", "user", "go"),
      JSON.stringify({
        id: "g1", type: "gemini",
        // the SAME call (tc1) appears both as a recorded entry and a functionCall part —
        // one chip, and the recorded entry's displayName wins; tc9 exists only as a part
        toolCalls: [{ id: "tc1", name: "run_shell_command", displayName: "Shell", args: { command: "ls" } }],
        content: [
          { functionCall: { id: "tc1", name: "run_shell_command", args: { command: "ls" } } },
          { functionCall: { id: "tc9", name: "glob", args: { pattern: "*.md" } } },
        ],
      }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages[1].toolCalls).toEqual([
      { name: "Shell", input: "ls" }, // recorded entry, not a duplicate part-derived chip
      { name: "glob", input: "*.md" },
    ]);
  });

  it("a functionCall part id suppresses the functionResponse fallback (no double chips)", async () => {
    const p = writeSession("h-fcdedup", "session-fcdedup.jsonl", [
      HDR("s"),
      MSG("u1", "user", "go"),
      JSON.stringify({ id: "g1", type: "gemini", content: [
        { text: "On it." },
        { functionCall: { id: "call9", name: "glob", args: { pattern: "**/*.ts" } } },
      ] }),
      // call9's response must NOT synthesize a second chip; the unrecorded other1 must
      JSON.stringify({ id: "u2", type: "user", content: [FR("call9", "glob"), FR("other1", "read_file")] }),
      MSG("g2", "gemini", "done"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["g1", "assistant"], // the call renders here, from the functionCall part…
      ["u2", "tool"], // …and the tool row carries ONLY the unrecorded response
      ["g2", "assistant"],
    ]);
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "glob", input: "**/*.ts" }]);
    expect(r!.session.messages[2].toolCalls).toEqual([{ name: "read_file", input: "" }]);
  });

  it("reseed merge keeps pre-compaction turns in place, appends the snapshot, recovers array text", async () => {
    const p = writeSession("h-reseed", "session-reseed.jsonl", [
      HDR("s"),
      MSG("u1", "user", "first question"),
      MSG("g0", "gemini", "pre-compaction answer"), // compressed away — NOT in the reseed
      MSG("u2", "user", "second question"),
      MSG("g1", "gemini", "will be reseeded"),
      JSON.stringify({ $set: { messages: [
        { id: "u2", type: "user", timestamp: "2026-06-19T11:45:00.000Z", content: [{ text: "second question" }] },
        { id: "g1", type: "gemini", timestamp: "2026-06-19T11:45:05.000Z", model: "gemini-2.5-pro",
          content: [{ text: "answer recovered from parts array" }] },
        { id: "s1", type: "user", timestamp: "2026-06-19T11:46:00.000Z", content: [{ text: STATE_SNAPSHOT }] },
      ] } }),
      MSG("u3", "user", "post-compaction question"),
      MSG("g2", "gemini", "post-compaction answer"),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    // chronologically sane: pre-compaction turns (original positions), then the snapshot
    // (new id → appends at the reseed), then post-compaction turns
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["g0", "assistant"], // absent from the reseed, but its record is earlier in the log — SURVIVES
      ["u2", "user"],
      ["g1", "assistant"],
      ["s1", "system"], // <state_snapshot> → muted system row, as usual
      ["u3", "user"],
      ["g2", "assistant"],
    ]);
    expect(r!.session.messages[1].text).toBe("pre-compaction answer");
    expect(r!.session.messages[3].text).toBe("answer recovered from parts array");
    expect(r!.session.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("end-to-end: the reseeded work-session shape yields assistant turns WITH text", async () => {
    // Pre-fix this parsed as "me, me" with no answers: every gemini turn array-content →
    // "" → dropped. Post-fix: user, assistant(tool chip), assistant(text).
    const p = writeSession("h-e2e", "session-e2e.jsonl", [
      HDR("s"),
      JSON.stringify({ $set: { messages: [
        { id: "u1", type: "user", content: [{ text: "where do the session files live?" }] },
        { id: "g1", type: "gemini", content: [
          { thought: true, text: "HIDDEN PLANNING" },
          { functionCall: { id: "c1", name: "read_file", args: { absolute_path: "/x.ts" } } },
        ] },
        { id: "u2", type: "user", content: [FR("c1", "read_file")] }, // fully deduped away
        { id: "g2", type: "gemini", content: [{ text: "They live under ~/.gemini/tmp." }] },
      ] } }),
    ].join("\n"));
    const r = await geminiCliAdapter.parse(refFor(p));
    expect(r!.session.messages.map((m) => [m.uid, m.role])).toEqual([
      ["u1", "user"],
      ["g1", "assistant"], // kept: empty text but a real functionCall-derived chip
      ["g2", "assistant"],
    ]);
    expect(r!.session.messages[1].toolCalls).toEqual([{ name: "read_file", input: "/x.ts" }]);
    expect(r!.session.messages[2].text).toBe("They live under ~/.gemini/tmp.");
    const json = JSON.stringify(r!.session.messages);
    expect(json).not.toContain("HIDDEN PLANNING");
    expect(json).not.toContain("NEVER CAPTURED");
  });
});
