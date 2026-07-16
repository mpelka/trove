import { Glob } from "bun";
import { homedir } from "node:os";
import { join, dirname, basename, relative, sep } from "node:path";
import { statSync, readFileSync } from "node:fs";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
  ToolCall,
} from "./types.ts";
import { shellQuote } from "./shell.ts";

const DEFAULT_TMP_DIR = join(homedir(), ".gemini", "tmp");

const SHELL_INPUT_MAX = 500;
const OTHER_INPUT_MAX = 200;

/** Collapse whitespace to single spaces and truncate to `max` chars (with an ellipsis). */
function compact(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Derive a SHORT, one-line input descriptor for a recorded tool call, never including
 *  large blob fields (content, new_string, old_string, file bodies) — mirrors the CC
 *  adapter's toolInput (issue #20). `name` is the tool's INTERNAL name (e.g.
 *  run_shell_command), which is what gemini keys args by. */
function toolInput(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  // Shell: the whole command, generously truncated (the CC adapter's Bash rule).
  if (name === "run_shell_command" && typeof o.command === "string") {
    return compact(o.command, SHELL_INPUT_MAX);
  }
  // Everything else: first useful key present, in priority order. Same list as the CC
  // adapter plus gemini's own arg names (absolute_path for read_file, prompt for web_fetch).
  for (const key of [
    "command",
    "file_path",
    "absolute_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return compact(v, OTHER_INPUT_MAX);
  }
  return ""; // no useful scalar key → name-only
}

/**
 * Map a gemini message's recorded `toolCalls` array into compact ToolCall records.
 * Each entry (verified in the 0.44.1 bundle) looks like
 * `{id, name, displayName, description, args, result, status, …}` — we keep only the
 * human label (`displayName`, falling back to `name`) and a short args descriptor;
 * `result` bodies and everything else are the bloat we drop. Untrusted input: every
 * field is type-guarded, garbage entries are skipped rather than thrown on.
 */
function extractToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const internal = typeof c.name === "string" && c.name.trim() ? c.name.trim() : null;
    const display =
      typeof c.displayName === "string" && c.displayName.trim() ? c.displayName.trim() : null;
    const name = display ?? internal;
    if (!name) continue; // no usable name at all → not a tool call we can show
    out.push({ name, input: toolInput(internal ?? name, c.args) });
  }
  return out;
}

/** Discovery root. `TROVE_GEMINI_ROOT` overrides the default `~/.gemini/tmp`;
 *  read per call (not at module load) so tests can point it at a fixture tree. */
function tmpDir(): string {
  return process.env.TROVE_GEMINI_ROOT || DEFAULT_TMP_DIR;
}

/** One gemini message. Assistant content is a plain string in fresh records but the API
 *  PARTS ARRAY after a reseed (see extractGeminiText); user content is an array of parts
 *  (or, legacy, a plain string). Fields we don't touch are optional. */
interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string; // "user" | "gemini" | "info" | "error"
  content?: unknown;
  thoughts?: unknown; // model reasoning — dropped
  toolCalls?: unknown; // recorded tool invocations on "gemini" messages — mapped compactly
  tokens?: unknown;
  model?: string;
}

/** Read the `.project_root` plaintext sibling for a session file. The chats dir's
 *  parent holds it: …/<project>/chats/<file> → …/<project>/.project_root. Returns
 *  the plaintext origin path, or null if absent/unreadable. */
function resolveProjectFromFile(sourceFile: string): string | null {
  try {
    const projectDir = dirname(dirname(sourceFile));
    const contents = readFileSync(join(projectDir, ".project_root"), "utf8").trim();
    return contents || null;
  } catch {
    return null;
  }
}

/**
 * Harness-injected pseudo-user turns — the CLI talking to itself, not the human. Dropped at
 * ingest, mirroring the CC adapter's SYNTHETIC_PREFIXES.
 *
 * `<session_context>` is gemini's environment preamble (date, OS, temp dir, directory tree,
 * memory). Verified in the @google/gemini-cli 0.44.1 and 0.50.0 bundles alike (still present
 * in the latest): getInitialChatHistory() unshifts
 * exactly ONE message — `{role:"user", parts:[{text:"<session_context>…"}]}` under the stable
 * id deriveStableId(["environment-context"]) — with no assistant reply. It's the whole
 * message, never a wrapper around real input, so dropping it can't lose anything the user
 * typed. Left in, it shows as the human's opening line AND becomes the derived title, which
 * made every affected session look identical in the list.
 *
 * `- **Workspace Directories:**` is the CLI's workspace announcement — another whole
 * message the harness injects as a fake user turn (observed in a real 0.44.1 .jsonl log,
 * sibling of `<session_context>`). Same treatment: it's the CLI talking to itself, drop it.
 */
const SYNTHETIC_USER_PREFIXES = ["<session_context>", "- **Workspace Directories:**"];

function isSyntheticUser(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * `<state_snapshot>` is gemini's compression/resume artifact — a summary of the truncated
 * history injected as a fake user turn (observed in a real 0.44.1 .jsonl log). Unlike the
 * SYNTHETIC_USER_PREFIXES it is NOT dropped: it's informative (what the model was told the
 * past looked like), just not the human talking — so it becomes a muted system row, the
 * same way CC compaction summaries render.
 */
const STATE_SNAPSHOT_PREFIX = "<state_snapshot>";

function isStateSnapshot(text: string): boolean {
  return text.trimStart().startsWith(STATE_SNAPSHOT_PREFIX);
}

/**
 * Extract the answer text from a gemini message's `content`.
 *
 * Fresh records store assistant content as a plain STRING — but after a RESEED (see
 * replaySessionLog) it becomes the API's PARTS ARRAY: updateMessagesFromHistory in the
 * 0.44.1 bundle rewrites every surviving message as
 * `{...existing, content: turn.content.parts || []}`, i.e. `[{text}, {functionCall:{…}},
 * …]`, some parts flagged as model reasoning. Treating array content as "" (the old
 * behavior) parsed every post-reseed assistant turn empty, so it was dropped and whole
 * conversations rendered as runs of user messages with tool strips and no answers.
 *
 * Thought detection is defensive: ANY truthy `thought` marker on a part (the API sets
 * `thought: true` on reasoning parts) means model reasoning, not the answer — the same
 * policy as dropping the `thoughts` field on fresh records. A plain `{text}` part is the
 * answer. Joined with "\n\n" like extractUserText.
 */
function extractGeminiText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const prose: string[] = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === "string") {
      if (part.trim()) prose.push(part.trim());
      continue;
    }
    if (typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.thought) continue; // truthy thought flag → reasoning, dropped like `thoughts`
    if (typeof p.text === "string" && p.text.trim()) prose.push(p.text.trim());
  }
  return prose.join("\n\n");
}

/**
 * ToolCall records from `functionCall` parts in a reseeded gemini message's parts array.
 * These are the REAL call side — name + args straight from the model — richer than the
 * name-only functionResponse fallback below. `excludeIds`: call ids already covered by
 * the same message's recorded `toolCalls` entries (those carry displayName, so they win
 * on an id collision); an id-less part is kept — fail toward showing the tool.
 */
function toolCallsFromFunctionCallParts(content: unknown, excludeIds: Set<string>): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCall[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const fc = (part as Record<string, unknown>).functionCall;
    if (!fc || typeof fc !== "object") continue;
    const f = fc as Record<string, unknown>;
    const id = typeof f.id === "string" && f.id ? f.id : null;
    if (id && excludeIds.has(id)) continue; // recorded toolCalls entry wins
    const name = typeof f.name === "string" && f.name.trim() ? f.name.trim() : null;
    if (!name) continue; // no usable name → not showable
    out.push({ name, input: toolInput(name, f.args) });
  }
  return out;
}

/** Extract the "meat" from one user message.content array: keep `text` parts,
 *  drop `functionResponse` (tool results) and `inlineData` (base64 blobs). A plain
 *  string content (legacy shape) is kept as-is. */
function extractUserText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const prose: string[] = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === "string") {
      if (part.trim()) prose.push(part.trim());
      continue;
    }
    if (typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    // keep text; functionResponse / inlineData → dropped (tool bodies + blobs)
    if (typeof p.text === "string" && p.text.trim()) prose.push(p.text.trim());
  }
  return prose.join("\n\n");
}

/** The call ids carried on one gemini message's recorded `toolCalls` entries. */
function toolCallEntryIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/**
 * Pre-pass: collect the ids of every tool call RECORDED on gemini messages, across the
 * whole session. Needed to dedup the functionResponse fallback below — when gemini did
 * record `toolCalls`, the same calls' functionResponses are also present on user-type
 * messages, and without this set every call would render twice. A whole-session pass
 * (not a running set) because replay order means a call's `toolCalls` may be recorded on
 * a message that appears before OR after its functionResponse.
 *
 * `functionCall` PARTS count as recorded too: a reseeded gemini message carries the call
 * side inside its parts-array content (see extractGeminiText / toolCallsFromFunctionCallParts),
 * and those parts render as real chips on the assistant turn — so their ids must suppress
 * the functionResponse fallback the same way recorded `toolCalls` ids do, or every call
 * would show twice after a reseed.
 */
function collectRecordedToolCallIds(rawMessages: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(rawMessages)) return ids;
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as GeminiMessage;
    if (m.type !== "gemini") continue;
    for (const id of toolCallEntryIds(m.toolCalls)) ids.add(id);
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        const fc = (part as Record<string, unknown>).functionCall;
        if (!fc || typeof fc !== "object") continue;
        const id = (fc as Record<string, unknown>).id;
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Fallback tool-call records synthesized from a user message's `functionResponse` parts.
 *
 * In some real 0.44.1 sessions (observed on-disk) the CALL side of tool use is never
 * persisted — gemini turns carry only `thoughts` and no `toolCalls` field at all — so the
 * functionResponse parts on the following user-type message are the ONLY trace that tools
 * ran. Each part looks like `{functionResponse: {id, name, response: {output: …}}}`. We
 * keep just the name (name-only chips); `response` bodies are exactly the blobs types.ts
 * forbids capturing. Parts whose id is in `recordedIds` are skipped (already shown via the
 * gemini turn's recorded toolCalls); a part with NO id is synthesized anyway — fail toward
 * showing the tool, dedup is best-effort.
 */
function toolCallsFromFunctionResponses(content: unknown, recordedIds: Set<string>): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCall[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const fr = (part as Record<string, unknown>).functionResponse;
    if (!fr || typeof fr !== "object") continue;
    const f = fr as Record<string, unknown>;
    const id = typeof f.id === "string" && f.id ? f.id : null;
    if (id && recordedIds.has(id)) continue; // the call side was recorded — don't show twice
    const name = typeof f.name === "string" && f.name.trim() ? f.name.trim() : null;
    if (!name) continue; // no usable name → nothing showable
    out.push({ name, input: "" });
  }
  return out;
}

/**
 * Stable identity for a session file: `<project>/<stem>`, e.g. `projects-1/session-2026-04-22T07-21-3ae2c125`.
 *
 * The filename stem ALONE is not unique, despite looking like it should be. gemini names
 * files `session-<timestamp-to-the-minute>-<first 8 chars of sessionId>`, so two sessions
 * started in the same minute whose ids share a prefix collide — and agent-to-agent sessions
 * all begin `a2a-serv`, so EVERY pair of them started in the same minute produces the same
 * filename across different projects. Real-world store: 4 projects each holding
 * `session-2026-06-17T14-10-a2a-serv`. Keying on the stem silently dropped all but the first.
 *
 * The in-content sessionId is no good either (it's shared across resumes/subagents), so the
 * path is the identity — it's what actually distinguishes these files.
 */
function sessionKey(root: string, path: string): string {
  const rel = relative(root, path);
  const project = rel.split(sep)[0] || "_";
  const stem = basename(path).replace(/\.jsonl?$/, "");
  return `${project}/${stem}`;
}

/** Seed/append message records (objects carrying a string `id`) into the replay map. */
function seedMessages(arr: unknown, into: Map<string, unknown>): void {
  if (!Array.isArray(arr)) return;
  for (const m of arr) {
    if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
      into.set((m as { id: string }).id, m);
    }
  }
}

/**
 * Rebuild a session from a `.jsonl` log — the CURRENT gemini format.
 *
 * A `.jsonl` is an append-only MUTATION LOG, not a session document: you can't just parse
 * it, you have to replay it. Record types mirror `loadConversationRecord`, verified
 * byte-identical in the published 0.44.1 AND 0.50.0 bundles (not guessed, and stable across
 * that whole range):
 *   - `{sessionId, projectHash, …}`  header  → merge into metadata; may carry `messages`
 *   - `{id, …}`                      message → upsert into the map BY ID, so a re-emitted
 *                                              id edits in place and order is insertion order
 *   - `{$set: {...}}`                        → merge into metadata; a `messages` array here
 *                                              is a RESEED — MERGED by id, NOT a replace
 *                                              (deliberate divergence from the vendor; see
 *                                              the inline comment on that branch)
 *   - `{$rewindTo: id}`              rewind  → drop that message and everything after it;
 *                                              an unknown id clears the history entirely
 *
 * Returns the same shape the `.json` format has, so the parser downstream is format-agnostic.
 *
 * MIRROR CONTRACT: scripts/diagnose-gemini-replay.sh replays logs with these exact
 * semantics to explain reader/raw-view mismatches. If you change a branch here, change
 * the script too (and vice versa), or the diagnostic silently starts lying.
 */
function replaySessionLog(text: string): Record<string, unknown> | null {
  let metadata: Record<string, unknown> = {};
  const messages = new Map<string, unknown>();
  let sawRecord = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // fail soft per line — a torn tail shouldn't lose the whole session
    }
    if (!r || typeof r !== "object") continue;
    sawRecord = true;

    if (typeof r.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const idx = ids.indexOf(r.$rewindTo);
      if (idx === -1) messages.clear();
      else for (const id of ids.slice(idx)) messages.delete(id);
    } else if (typeof r.id === "string") {
      messages.set(r.id, r);
    } else if (r.$set && typeof r.$set === "object") {
      if (Array.isArray(r.$set.messages)) {
        // A `$set.messages` array is a RESEED: chatRecordingService.updateMessagesFromHistory
        // (verified in the 0.44.1 bundle) runs after a rewind and after COMPACTION, rebuilds
        // the message list from the MODEL's in-memory history, and emits it wholesale.
        // Crucially, that array reflects what the model still REMEMBERS, not what happened:
        // turns compressed away by compaction — and CLI-side info/error records, which were
        // never in the model's history — are simply absent, even though their records still
        // sit EARLIER in this same file. The vendor's own loader replays this as a replace,
        // which is right for the CLI (it only needs the model's working memory) — but trove
        // is an ARCHIVE, and those pre-compaction records are its whole value. Clearing here
        // implemented the vendor's amnesia; merging implements an archive. So: upsert each
        // seeded message by id — existing ids keep their map position and take the reseeded
        // body, new ids (e.g. the <state_snapshot> compaction summary) append at the end as
        // of this reseed, and subsequent records keep appending after them, so the final
        // order reads chronologically.
        // DELIBERATE ASYMMETRY with $rewindTo above: a rewind is the USER destroying history
        // on purpose (target-inclusive deletion, verified against the bundle's
        // slice(0, messageIndex)), so it deletes; a reseed is the model forgetting, so it
        // must not. (Fallout of the old clear+seed: 20+ real sessions lost pre-compaction
        // turns, the worst dropping 6000+ message-states.)
        seedMessages(r.$set.messages, messages);
      }
      metadata = { ...metadata, ...r.$set };
    } else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") {
      metadata = { ...metadata, ...r };
      seedMessages(r.messages, messages);
    }
  }
  if (!sawRecord) return null;
  // `messages` last: metadata may carry a stale copy from a $set spread.
  return { ...metadata, messages: [...messages.values()] };
}

export const geminiCliAdapter: Adapter = {
  agentId: "gemini-cli",

  discoverLocations() {
    return [tmpDir()];
  },

  async enumerate(): Promise<SourceRef[]> {
    const root = tmpDir();
    const refs: SourceRef[] = [];
    // One session per file under ~/.gemini/tmp/<project>/chats/session-*.
    // BOTH extensions. `.jsonl` (an append-only mutation log) is what gemini writes now —
    // verified in the 0.44.1, 0.49.0 and 0.50.0 bundles alike. `.json` is a whole-document
    // LEGACY format from some pre-0.44 release; stores still hold them (this dev box has 33,
    // untouched since March), so keep reading them.
    // The `session-` prefix also keeps out nested `chats/<id>/<id>.jsonl` skill/subagent
    // transcripts — internal noise, same as the CC adapter's subagent filter.
    const glob = new Glob("*/chats/session-*.{json,jsonl}");
    // Keyed by <project>/<stem> — the session identity (see sessionKey). A store can hold a
    // legacy `session-X.json` NEXT TO its live `session-X.jsonl`; they're the same
    // conversation in two formats, so take the .jsonl (the live log, and the only one with
    // the full rewind history) and drop the twin rather than importing it twice.
    // NOTE the direction: .jsonl is the NEWER format, so preferring it is also future-proof.
    // Do not "fix" this to prefer .json on the assumption that .json looks more modern.
    const byKey = new Map<string, SourceRef>();
    try {
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
        const path = join(root, rel);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        const key = sessionKey(root, path);
        if (byKey.has(key) && !path.endsWith(".jsonl")) continue; // keep the .jsonl twin
        byKey.set(key, {
          agent: this.agentId,
          medium: "file",
          path,
          sizeBytes: st.size,
          mtimeMs: Math.floor(st.mtimeMs),
        });
      }
    } catch {
      // tmp dir absent → no sessions
    }
    refs.push(...byKey.values());
    return refs;
  },

  async parse(ref: SourceRef): Promise<ParseResult | null> {
    const bytes = await Bun.file(ref.path).bytes();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const contentHash = hasher.digest("hex");

    const text = new TextDecoder().decode(bytes);
    let root: any;
    if (ref.path.endsWith(".jsonl")) {
      // The current format: an append-only mutation log — replay it into a session document.
      root = replaySessionLog(text);
    } else {
      try {
        root = JSON.parse(text);
      } catch {
        return null; // fail soft on a corrupt file
      }
    }
    if (!root || typeof root !== "object") return null;

    // Subagent transcripts are internal noise — skip, matching how the CC adapter
    // filters subagent files. Legacy sessions have kind === null and are kept.
    if (root.kind === "subagent") return null;

    const rawMessages: unknown = root.messages;
    const messages: NormalizedMessage[] = [];
    let seq = 0;
    let model: string | null = null;
    let minTs = Infinity;
    let maxTs = -Infinity;

    // Whole-session pre-pass (see collectRecordedToolCallIds): which call ids already
    // have a recorded `toolCalls` entry, so the functionResponse fallback can dedup.
    const recordedToolCallIds = collectRecordedToolCallIds(rawMessages);

    if (Array.isArray(rawMessages)) {
      for (const raw of rawMessages) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as GeminiMessage;
        const t = m.type;

        // gemini → assistant (string content when fresh, parts array after a reseed; tool
        // calls ride along in `toolCalls` and/or functionCall parts), user → user (array
        // of parts), error → system (explains gaps in broken conversations). info is CLI
        // status noise — skip (not chat meat).
        let role: NormalizedMessage["role"];
        let text: string;
        let toolCalls: ToolCall[] = [];
        if (t === "gemini") {
          role = "assistant";
          text = extractGeminiText(m.content);
          // A tool-only turn is recorded with content: "" and the substance in toolCalls
          // (verified in the 0.44.1 bundle) — dropping empties blindly erased every
          // agentic assistant turn, leaving long runs of user messages.
          toolCalls = extractToolCalls(m.toolCalls);
          if (Array.isArray(m.content)) {
            // Reseeded turn: the parts array carries the REAL call side as functionCall
            // parts. Merge them after any recorded `toolCalls`; on an id collision the
            // recorded entry wins (it carries displayName).
            toolCalls = [
              ...toolCalls,
              ...toolCallsFromFunctionCallParts(m.content, toolCallEntryIds(m.toolCalls)),
            ];
          }
        } else if (t === "user") {
          text = extractUserText(m.content);
          // Drop the CLI's own harness-injected turns — not the human talking.
          if (isSyntheticUser(text)) continue;
          if (!text) {
            // No typed text at all. If the parts carry functionResponses this is the
            // response side of tool use — and in sessions where gemini never recorded
            // the call side, the only trace tools ran. Surface it as a tool row
            // (name-only chips, deduped against recorded toolCalls). Text wins: a real
            // user message that merely includes a functionResponse part stays "user".
            toolCalls = toolCallsFromFunctionResponses(m.content, recordedToolCallIds);
            if (toolCalls.length === 0) continue; // pure noise (or fully deduped) — skip
            role = "tool";
            // Same `[used: …]` marker convention as the CC adapter: buildItems derives
            // the strip's grouped counts from this text.
            text = `[used: ${[...new Set(toolCalls.map((c) => c.name))].join(", ")}]`;
          } else if (isStateSnapshot(text)) {
            // Compression/resume summary — informative, but not the human. Muted
            // system row, like CC compaction turns.
            role = "system";
          } else {
            role = "user";
          }
        } else if (t === "error") {
          role = "system";
          text = typeof m.content === "string" ? m.content.trim() : "";
        } else {
          continue;
        }

        if (typeof m.model === "string") model = m.model;

        const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
        if (!Number.isNaN(ts)) {
          minTs = Math.min(minTs, ts);
          maxTs = Math.max(maxTs, ts);
        }

        // A gemini message that is empty AND has no tool calls (thought-only turn) is
        // skipped — but an empty one WITH tool calls is a real assistant turn and stays.
        // (Empty user messages were already handled above: functionResponse parts became
        // a tool row, anything else — e.g. inlineData only — was dropped.)
        if (!text && toolCalls.length === 0) continue;

        messages.push({
          uid: typeof m.id === "string" ? m.id : null,
          seq: seq++,
          role,
          // No parent links — messages are a flat, time-ordered array.
          parentUid: null,
          timestamp: Number.isNaN(ts) ? null : ts,
          text,
          ...(toolCalls.length ? { toolCalls } : {}),
        });
      }
    }

    const st = statSync(ref.path);
    // startTime/lastUpdated are ISO strings; fall back to message span, then file mtime.
    const startTs =
      typeof root.startTime === "string" ? Date.parse(root.startTime) : NaN;
    const updatedTs =
      typeof root.lastUpdated === "string" ? Date.parse(root.lastUpdated) : NaN;
    const createdAt = !Number.isNaN(startTs)
      ? startTs
      : Number.isFinite(minTs)
        ? minTs
        : Math.floor(st.mtimeMs);
    const updatedAt = !Number.isNaN(updatedTs)
      ? updatedTs
      : Number.isFinite(maxTs)
        ? maxTs
        : Math.floor(st.mtimeMs);

    // Identity is the filename stem (unique per file), NOT the in-content sessionId — which is
    // shared across resumes/subagents and would silently collapse+lose sessions (same lesson as
    // the CC adapter). The sessionId is kept in agentSpecific for later parent-grouping.
    const nativeId = sessionKey(tmpDir(), ref.path);
    const session: NormalizedSession = {
      nativeId,
      projectPath: resolveProjectFromFile(ref.path),
      createdAt,
      updatedAt,
      model,
      sourceTitle: null,
      kind: typeof root.kind === "string" ? root.kind : null,
      agentSpecific: {
        sourceFile: ref.path,
        projectHash: typeof root.projectHash === "string" ? root.projectHash : null,
        kind: typeof root.kind === "string" ? root.kind : null,
        contentSessionId: typeof root.sessionId === "string" ? root.sessionId : null,
      },
      messages,
    };
    return { session, contentHash, raw: bytes };
  },

  /** Best-effort origin path: read the session file's `.project_root` sibling (see
   *  resolveProjectFromFile). Uses `agentSpecific.sourceFile` stashed during parse. */
  resolveProject(session: NormalizedSession): string | null {
    const file = session.agentSpecific?.sourceFile;
    if (typeof file !== "string") return session.projectPath ?? null;
    return resolveProjectFromFile(file);
  },

  /** Resume via `gemini --session-file`. This needs the *raw* session JSON, so it only
   *  works when a gzipped raw archive was kept (--keep-raw); we decompress it to a temp
   *  file first. A slim (raw-less) copy can't round-trip → null. */
  buildResumeCommand(input): string | null {
    if (!input.rawPath) return null;
    const cd = input.projectPath ? `cd ${shellQuote(input.projectPath)} && ` : "";
    return (
      `${cd}RAW=$(mktemp /tmp/trove-resume-XXXXXX.json) && ` +
      `gunzip -c ${shellQuote(input.rawPath)} > "$RAW" && ` +
      `gemini --session-file "$RAW"`
    );
  },
};
