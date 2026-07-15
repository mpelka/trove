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
} from "./types.ts";
import { shellQuote } from "./shell.ts";

const DEFAULT_TMP_DIR = join(homedir(), ".gemini", "tmp");

/** Discovery root. `TROVE_GEMINI_ROOT` overrides the default `~/.gemini/tmp`;
 *  read per call (not at module load) so tests can point it at a fixture tree. */
function tmpDir(): string {
  return process.env.TROVE_GEMINI_ROOT || DEFAULT_TMP_DIR;
}

/** One gemini message. Assistant content is a plain string; user content is an
 *  array of parts (or, legacy, a plain string). Fields we don't touch are optional. */
interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string; // "user" | "gemini" | "info" | "error"
  content?: unknown;
  thoughts?: unknown; // model reasoning — dropped
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
 * memory). Verified in the @google/gemini-cli 0.44 bundle: getInitialChatHistory() unshifts
 * exactly ONE message — `{role:"user", parts:[{text:"<session_context>…"}]}` under the stable
 * id deriveStableId(["environment-context"]) — with no assistant reply. It's the whole
 * message, never a wrapper around real input, so dropping it can't lose anything the user
 * typed. Left in, it shows as the human's opening line AND becomes the derived title, which
 * made every affected session look identical in the list.
 */
const SYNTHETIC_USER_PREFIXES = ["<session_context>"];

function isSyntheticUser(text: string): boolean {
  const t = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
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
 * Rebuild a session from a `.jsonl` log (gemini-cli 0.44.x).
 *
 * Unlike the `.json` format (0.49.x), which is a whole session document, a `.jsonl` is an
 * append-only MUTATION LOG — you can't just parse it, you have to replay it. Record types,
 * mirroring `loadConversationRecord` in @google/gemini-cli 0.44 (verified against the
 * published bundle, not guessed):
 *   - `{sessionId, projectHash, …}`  header  → merge into metadata; may carry `messages`
 *   - `{id, …}`                      message → upsert into the map BY ID, so a re-emitted
 *                                              id edits in place and order is insertion order
 *   - `{$set: {...}}`                        → merge into metadata; a `messages` array here
 *                                              REPLACES the whole map (clear + re-seed)
 *   - `{$rewindTo: id}`              rewind  → drop that message and everything after it;
 *                                              an unknown id clears the history entirely
 *
 * Returns the same shape the `.json` format has, so the parser downstream is format-agnostic.
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
        messages.clear();
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
    // BOTH extensions: 0.49.x writes a whole-document `.json`, 0.44.x an append-only
    // `.jsonl` mutation log. Machines run different gemini-cli generations, so support
    // both rather than making the user configure it.
    // The `session-` prefix also keeps out nested `chats/<id>/<id>.jsonl` skill/subagent
    // transcripts — internal noise, same as the CC adapter's subagent filter.
    const glob = new Glob("*/chats/session-*.{json,jsonl}");
    // Keyed by <project>/<stem> — the session identity (see sessionKey). A 0.44 store can
    // hold a legacy `session-X.json` NEXT TO its live `session-X.jsonl`; they're the same
    // conversation in two formats, so take the .jsonl (the live log, and the only one with
    // the full rewind history) and drop the twin rather than importing it twice.
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
      // 0.44.x: an append-only mutation log — replay it into a session document.
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

    if (Array.isArray(rawMessages)) {
      for (const raw of rawMessages) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as GeminiMessage;
        const t = m.type;

        // gemini → assistant (plain string), user → user (array of parts).
        // info/error are system status/error strings — skip (not chat meat).
        let role: NormalizedMessage["role"];
        let text: string;
        if (t === "gemini") {
          role = "assistant";
          text = typeof m.content === "string" ? m.content.trim() : "";
        } else if (t === "user") {
          role = "user";
          text = extractUserText(m.content);
          // Drop the CLI's own environment preamble — not the human talking.
          if (isSyntheticUser(text)) continue;
        } else {
          continue;
        }

        if (typeof m.model === "string") model = m.model;

        const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
        if (!Number.isNaN(ts)) {
          minTs = Math.min(minTs, ts);
          maxTs = Math.max(maxTs, ts);
        }

        // A user message with only functionResponse/inlineData yields empty text →
        // skip it (don't emit empties), exactly like the CC adapter.
        if (!text) continue;

        messages.push({
          uid: typeof m.id === "string" ? m.id : null,
          seq: seq++,
          role,
          // No parent links — messages are a flat, time-ordered array.
          parentUid: null,
          timestamp: Number.isNaN(ts) ? null : ts,
          text,
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
