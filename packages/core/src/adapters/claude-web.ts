import { Glob } from "bun";
import { join, relative } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { importsDir } from "../paths.ts";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
  ToolCall,
} from "./types.ts";

/**
 * claude.ai web-export importer. Mirrors the ChatGPT web adapter: there's no live store to
 * poll — the user unzips an official claude.ai data export into `~/.trove/imports/` (any
 * depth), and `trove sync` ingests it like any other default adapter (incrementality,
 * tombstones and `--force` all come for free). Imports surface as a NEW agent `claude-web`
 * with its own chip/badge (labeled "claude.ai" to distinguish from claude-CODE) — no
 * "imported" flag, no cross-agent grouping.
 *
 * Export shape: `conversations.json` is a JSON ARRAY of conversation objects. Each has a
 * `uuid`, `name` (often ""), `summary` (often ""), `created_at`/`updated_at` (ISO-8601),
 * `account`, and `chat_messages` (already CHRONOLOGICAL). We read ONLY files literally named
 * `conversations.json`; `projects/*.json`, `memories.json`, `design_chats/*.json` are
 * naturally excluded. Attachments/files are imported as text REFERENCES, never binaries.
 *
 * A claude.ai export has ~1099 conversations but only ~467 with a real exchange: 26 have
 * zero messages, ~606 have messages but no usable prose. We enumerate anything with ≥1
 * chat_message, but parse() returns null for empty shells (no user prose AND no assistant
 * prose), so only real conversations land.
 */

const PATH_SEP = "#";
const BASH_INPUT_MAX = 500;
const OTHER_INPUT_MAX = 200;

// ── claude.ai export JSON shapes (only the fields we read) ───────────────────
interface Attachment {
  file_name?: string;
  // (file_size, file_type, extracted_content also present — we deliberately drop them)
}
interface FileRef {
  file_name?: string;
}
interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface ChatMessage {
  uuid?: string;
  text?: string;
  content?: ContentBlock[];
  sender?: string;
  created_at?: string;
  updated_at?: string;
  attachments?: Attachment[];
  files?: FileRef[];
  parent_message_uuid?: string | null;
}
interface Conversation {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  account?: unknown;
  chat_messages?: ChatMessage[];
}

/**
 * Per-(file,mtime) cache of the parsed conversations array, so parse() doesn't re-read and
 * re-parse the (73 MB) conversations.json once per conversation (~1099×). Keyed by
 * `${absPath}:${mtimeMs}` so a re-exported file (new mtime) invalidates the old entry.
 */
const exportCache = new Map<string, Conversation[]>();

/** Signature-guard: a claude.ai export is a JSON array whose first item carries
 *  `chat_messages`, `uuid` AND `account`. This is DISTINCT from ChatGPT's `mapping` +
 *  `conversation_id`, so the two adapters never fight over the same file. */
function looksLikeClaudeExport(parsed: unknown): parsed is Conversation[] {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const first = parsed[0];
  return (
    !!first &&
    typeof first === "object" &&
    "chat_messages" in first &&
    "uuid" in first &&
    "account" in first
  );
}

/** Load + parse an export file (through the cache). Returns null on read/parse failure or
 *  if the file isn't a claude.ai export. */
function loadExport(absPath: string, mtimeMs: number): Conversation[] | null {
  const key = `${absPath}:${mtimeMs}`;
  const hit = exportCache.get(key);
  if (hit) return hit;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
  if (!looksLikeClaudeExport(parsed)) return null;
  exportCache.set(key, parsed);
  return parsed;
}

/** Collapse whitespace to single spaces and truncate to `max` chars (with an ellipsis). */
function compact(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Derive a SHORT, one-line input descriptor for a tool_use block, never including large
 *  blob fields (content, new_string, old_string, file bodies). Mirrors the CC adapter:
 *  a string `command` is capped generously; otherwise JSON.stringify capped tighter. */
function toolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (typeof o.command === "string") return compact(o.command, BASH_INPUT_MAX);
  try {
    return compact(JSON.stringify(input), OTHER_INPUT_MAX);
  } catch {
    return "";
  }
}

/** Extract the "meat" from one message: keep `text` blocks (join with blank lines), record
 *  `tool_use` as a compact marker, drop thinking / tool_result / token_budget. Falls back to
 *  the flattened `text` field if `content` is absent/empty. */
function extractContent(m: ChatMessage): {
  text: string;
  hasProse: boolean;
  toolCalls?: ToolCall[];
} {
  const content = m.content;
  if (Array.isArray(content) && content.length) {
    const prose: string[] = [];
    const toolNames: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text.trim()) prose.push(block.text.trim());
          break;
        case "tool_use":
          if (typeof block.name === "string") {
            toolNames.push(block.name);
            toolCalls.push({ name: block.name, input: toolInput(block.input) });
          }
          break;
        // thinking, tool_result, token_budget → dropped (bulk + noise)
      }
    }
    // toolCalls are captured regardless of prose (a message may narrate AND call tools). When
    // there's no prose, the deduped `[used: …]` marker stands in as the message text.
    const calls = toolCalls.length ? toolCalls : undefined;
    if (prose.length) return { text: prose.join("\n\n"), hasProse: true, toolCalls: calls };
    if (toolNames.length) {
      const uniq = [...new Set(toolNames)];
      return { text: `[used: ${uniq.join(", ")}]`, hasProse: false, toolCalls: calls };
    }
    // content present but all-dropped → fall through to the flattened `text` field
  }
  const flat = typeof m.text === "string" ? m.text.trim() : "";
  return { text: flat, hasProse: flat.length > 0 };
}

/** Append `[attachment: name]` / `[file: name]` reference markers (never extracted_content
 *  or binaries) to a message's prose. */
function withReferences(text: string, m: ChatMessage): string {
  const refs: string[] = [];
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      if (!a || typeof a !== "object") continue;
      const name = typeof a.file_name === "string" ? a.file_name.trim() : "";
      refs.push(name ? `[attachment: ${name}]` : "[attachment]");
    }
  }
  if (Array.isArray(m.files)) {
    for (const f of m.files) {
      if (!f || typeof f !== "object") continue;
      const name = typeof f.file_name === "string" ? f.file_name.trim() : "";
      refs.push(name ? `[file: ${name}]` : "[file]");
    }
  }
  if (!refs.length) return text;
  const suffix = refs.map((r) => `\n${r}`).join("");
  return text ? text + suffix : suffix.trimStart();
}

export const claudeWebAdapter: Adapter = {
  agentId: "claude-web",

  discoverLocations() {
    return [importsDir()];
  },

  async enumerate(): Promise<SourceRef[]> {
    const root = importsDir();
    const refs: SourceRef[] = [];
    const glob = new Glob("**/conversations.json");
    let scanned: AsyncIterable<string>;
    try {
      // Tolerate the imports dir being ABSENT (glob.scan throws on a missing root).
      statSync(root);
      scanned = glob.scan({ cwd: root, onlyFiles: true });
    } catch {
      return [];
    }
    try {
      for await (const rel of scanned) {
        const absPath = join(root, rel);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(absPath);
        } catch {
          continue;
        }
        const mtimeMs = st.mtimeMs;
        const convs = loadExport(absPath, mtimeMs);
        if (!convs) continue; // not a claude.ai export → skip
        for (const conv of convs) {
          if (!conv || typeof conv.uuid !== "string" || !conv.uuid) continue;
          // Only conversations with ≥1 chat_message; empty shells (26 in the real export)
          // are never even listed. sizeBytes is the CONVERSATION's own JSON size so the list
          // shows a meaningful per-session size; combined with the file mtime it's a fine
          // change fingerprint (contentHash decides updated-vs-unchanged per conversation).
          if (!Array.isArray(conv.chat_messages) || conv.chat_messages.length === 0) continue;
          refs.push({
            agent: this.agentId,
            medium: "file",
            path: `${absPath}${PATH_SEP}${conv.uuid}`,
            sizeBytes: Buffer.byteLength(JSON.stringify(conv), "utf8"),
            mtimeMs,
            nativeIdHint: conv.uuid,
          });
        }
      }
    } catch {
      // scan error mid-stream → return what we have
    }
    return refs;
  },

  async parse(ref: SourceRef): Promise<ParseResult | null> {
    const sep = ref.path.lastIndexOf(PATH_SEP);
    if (sep < 0) return null;
    const absPath = ref.path.slice(0, sep);
    const uuid = ref.path.slice(sep + PATH_SEP.length);
    if (!uuid) return null;

    // Prefer the ref's mtime (cache hit from enumerate); fall back to a fresh stat.
    let mtimeMs = ref.mtimeMs;
    try {
      if (!mtimeMs) mtimeMs = statSync(absPath).mtimeMs;
    } catch {
      return null;
    }
    const convs = loadExport(absPath, mtimeMs);
    if (!convs) return null;

    const conv = convs.find((c) => c?.uuid === uuid);
    if (!conv) return null;

    const chatMessages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    const messages: NormalizedMessage[] = [];
    let seq = 0;
    let sawUserProse = false;
    let sawAssistantProse = false;
    // Walk in ARRAY ORDER (already chronological).
    for (const m of chatMessages) {
      if (!m || typeof m !== "object") continue;
      const extracted = extractContent(m);
      const text = withReferences(extracted.text, m);
      if (!text) continue; // nothing worth keeping (empty text + no references)

      // human → user; assistant with prose → assistant; assistant with only tool_use → tool.
      const role: NormalizedMessage["role"] =
        m.sender === "assistant"
          ? extracted.hasProse
            ? "assistant"
            : "tool"
          : "user";

      if (role === "user" && extracted.hasProse) sawUserProse = true;
      else if (role === "assistant") sawAssistantProse = true;

      const ts = typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN;
      messages.push({
        uid: typeof m.uuid === "string" ? m.uuid : null,
        seq: seq++,
        role,
        parentUid: m.parent_message_uuid ?? null,
        timestamp: Number.isNaN(ts) ? null : ts,
        text,
        ...(extracted.toolCalls?.length ? { toolCalls: extracted.toolCalls } : {}),
      });
    }

    // Empty shell: no user prose AND no assistant prose → skip (mirrors the "only ~467 real"
    // expectation; sync's turnCount gate is the backstop, returning null is cleaner).
    if (!sawUserProse && !sawAssistantProse) return null;

    const rawBytes = new TextEncoder().encode(JSON.stringify(conv));
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rawBytes);
    const contentHash = hasher.digest("hex");

    const createdAt =
      typeof conv.created_at === "string" ? Date.parse(conv.created_at) : NaN;
    const updatedAt =
      typeof conv.updated_at === "string" ? Date.parse(conv.updated_at) : NaN;
    const summary = typeof conv.summary === "string" ? conv.summary : "";

    const session: NormalizedSession = {
      nativeId: uuid,
      projectPath: null,
      createdAt: Number.isNaN(createdAt) ? null : createdAt,
      updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
      model: null, // messages carry no model field
      // names are OFTEN "" — sync then derives a title from the first user message.
      sourceTitle: conv.name?.trim() || null,
      kind: "chat",
      agentSpecific: {
        conversationUuid: uuid,
        exportFile: relative(importsDir(), absPath),
        summary: summary || null,
        url: `https://claude.ai/chat/${uuid}`,
      },
      messages,
    };
    return { session, contentHash, raw: rawBytes };
  },

  resolveProject(): string | null {
    return null; // web chats have no filesystem origin
  },

  buildResumeCommand(): string | null {
    return null; // not CLI-resumable; the claude.ai URL lives in agentSpecific
  },
};
