import { Glob } from "bun";
import { join, dirname, relative } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { importsDir } from "../paths.ts";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
} from "./types.ts";

/**
 * ChatGPT web-export importer. Unlike the CLI adapters, there's no live store to poll —
 * the user unzips an official ChatGPT data export into `~/.trove/imports/` (any depth),
 * and `trove sync` ingests it like any other default adapter (incrementality, tombstones
 * and `--force` all come for free). Imports surface as a normal agent `chatgpt` with its
 * own chip/badge — no "imported" flag, no cross-agent grouping.
 *
 * Export shape: an unzipped export dir holds `conversations.json` (a JSON array of
 * conversation objects), `conversation_asset_file_names.json` (maps `file-XXXX.dat` →
 * original filename), plus `chat.html` and `file-*.dat` attachment blobs. We read only
 * the two JSON files; attachments are imported as text REFERENCES (`[image: <name>]`),
 * never the binary.
 *
 * Each conversation's `mapping` is a node tree (edit-branches fan out as sibling
 * children). We linearize the ACTIVE branch only: start at `current_node`, walk `parent`
 * pointers to the root, then reverse — dead edit-branches are dropped.
 */

const PATH_SEP = "#";
const ASSET_MAP_FILENAME = "conversation_asset_file_names.json";

// ── ChatGPT export JSON shapes (only the fields we read) ─────────────────────
interface ChatMessage {
  id?: string;
  author?: { role?: string };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[] };
  metadata?: { model_slug?: string };
}
interface ChatNode {
  id?: string;
  message?: ChatMessage | null;
  parent?: string | null;
  children?: string[];
}
interface Conversation {
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  is_archived?: boolean;
  is_starred?: boolean;
  mapping?: Record<string, ChatNode>;
}

/**
 * Per-(file,mtime) cache of the parsed conversations array + asset map, so parse() doesn't
 * re-read and re-parse the (1–2 MB) conversations.json once per conversation (~95×). Keyed
 * by `${absPath}:${mtimeMs}` so a re-exported file (new mtime) invalidates the old entry.
 */
interface CachedExport {
  conversations: Conversation[];
  assetNames: Record<string, string>;
}
const exportCache = new Map<string, CachedExport>();

/** Signature-guard: a ChatGPT export is a JSON array whose items carry both `mapping`
 *  and `conversation_id`. Anything else in imports/ (unrelated json) is skipped. */
function looksLikeChatGptExport(parsed: unknown): parsed is Conversation[] {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const first = parsed[0];
  return (
    !!first &&
    typeof first === "object" &&
    "mapping" in first &&
    "conversation_id" in first
  );
}

/** Load + parse an export file (through the cache). Returns null on read/parse failure or
 *  if the file isn't a ChatGPT export. The asset-name map (optional, sitting next to it) is
 *  loaded best-effort. */
function loadExport(absPath: string, mtimeMs: number): CachedExport | null {
  const key = `${absPath}:${mtimeMs}`;
  const hit = exportCache.get(key);
  if (hit) return hit;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
  if (!looksLikeChatGptExport(parsed)) return null;
  const assetNames = loadAssetNames(join(dirname(absPath), ASSET_MAP_FILENAME));
  const value: CachedExport = { conversations: parsed, assetNames };
  exportCache.set(key, value);
  return value;
}

/** `conversation_asset_file_names.json` maps `file-XXXX.dat` → original filename. We index
 *  by the bare asset id (`file-XXXX`) too, since `asset_pointer`s reference that stem. */
function loadAssetNames(mapPath: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    return {}; // absent/unreadable → no name resolution, fall back to `[image]`
  }
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string" || !v) continue;
      out[k] = v;
      // `file-XXXX.dat` → also index the bare `file-XXXX` stem for asset_pointer matching.
      const stem = k.replace(/\.[^.]+$/, "");
      if (stem !== k) out[stem] = v;
    }
  }
  return out;
}

/** Resolve an `asset_pointer` (e.g. `file-service://file-ABC123`) to a display name via the
 *  export's asset map, or null if it can't be matched. */
function resolveAssetName(pointer: unknown, assetNames: Record<string, string>): string | null {
  if (typeof pointer !== "string") return null;
  // Take the trailing `file-XXXX` id after any `service://` prefix.
  const id = pointer.split("/").pop() || pointer;
  return assetNames[id] ?? assetNames[`${id}.dat`] ?? null;
}

/** Extract display text from one message's content. `text` → join non-empty string parts
 *  with blank lines. `multimodal_text` → walk parts in order, rendering image/attachment
 *  objects as reference markers, joined with newlines. */
function extractText(content: ChatMessage["content"], assetNames: Record<string, string>): string {
  if (!content || !Array.isArray(content.parts)) return "";
  const parts = content.parts;
  if (content.content_type === "multimodal_text") {
    const out: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        const s = part.trim();
        if (s) out.push(part); // keep original (untrimmed) prose; skip whitespace-only
        continue;
      }
      if (part && typeof part === "object") {
        const p = part as { content_type?: string; asset_pointer?: unknown };
        if (typeof p.content_type === "string" && p.content_type.includes("image")) {
          const name = resolveAssetName(p.asset_pointer, assetNames);
          out.push(name ? `[image: ${name}]` : "[image]");
        } else {
          out.push("[attachment]");
        }
      }
    }
    return out.join("\n");
  }
  // Plain text (and any other array-of-strings content_type): join non-empty strings.
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
}

/** Walk the active branch: current_node → parents → root, collecting non-null messages,
 *  then reverse into chronological order. */
function linearize(conv: Conversation): ChatMessage[] {
  const mapping = conv.mapping ?? {};
  const out: ChatMessage[] = [];
  let nodeId: string | null | undefined = conv.current_node;
  const seen = new Set<string>(); // cycle guard against malformed exports
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node) break;
    if (node.message) out.push(node.message);
    nodeId = node.parent;
  }
  out.reverse();
  return out;
}

export const chatgptWebAdapter: Adapter = {
  agentId: "chatgpt",

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
        const loaded = loadExport(absPath, mtimeMs);
        if (!loaded) continue; // not a ChatGPT export → skip
        for (const conv of loaded.conversations) {
          if (!conv || typeof conv.conversation_id !== "string" || !conv.conversation_id) continue;
          // One SourceRef per conversation; identity is `<file>#<conversation_id>`.
          // sizeBytes is the CONVERSATION's own JSON size (not the whole export file's) so
          // the list shows a meaningful per-session size; combined with the file mtime it's a
          // fine change fingerprint (a re-export bumps mtime → re-parse; contentHash then
          // decides updated-vs-unchanged per conversation).
          refs.push({
            agent: this.agentId,
            medium: "file",
            path: `${absPath}${PATH_SEP}${conv.conversation_id}`,
            sizeBytes: Buffer.byteLength(JSON.stringify(conv), "utf8"),
            mtimeMs,
            nativeIdHint: conv.conversation_id,
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
    const conversationId = ref.path.slice(sep + PATH_SEP.length);
    if (!conversationId) return null;

    // Prefer the ref's mtime (cache hit from enumerate); fall back to a fresh stat.
    let mtimeMs = ref.mtimeMs;
    try {
      if (!mtimeMs) mtimeMs = statSync(absPath).mtimeMs;
    } catch {
      return null;
    }
    const loaded = loadExport(absPath, mtimeMs);
    if (!loaded) return null;

    const conv = loaded.conversations.find((c) => c?.conversation_id === conversationId);
    if (!conv) return null;

    const chatMessages = linearize(conv);

    const messages: NormalizedMessage[] = [];
    let seq = 0;
    let prevUid: string | null = null;
    let lastModel: string | null = null;
    let sawUser = false;
    let sawAssistant = false;
    for (const m of chatMessages) {
      const role = m.author?.role;
      // Defensively filter to user/assistant only (system/tool/hidden shouldn't appear).
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(m.content, loaded.assetNames);
      if (!text) continue; // skip empty (e.g. a bare image with no resolvable ref would still emit a marker)
      if (role === "assistant" && typeof m.metadata?.model_slug === "string" && m.metadata.model_slug) {
        lastModel = m.metadata.model_slug; // model = last assistant message's slug
      }
      if (role === "user") sawUser = true;
      else sawAssistant = true;
      const uid = typeof m.id === "string" && m.id ? m.id : `msg-${seq}`;
      messages.push({
        uid,
        seq: seq++,
        role,
        // Thread the previous kept message as parent (mirrors the CC adapter's parentUuid intent).
        parentUid: prevUid,
        timestamp: m.create_time != null ? Math.round(m.create_time * 1000) : null,
        text,
      });
      prevUid = uid;
    }

    // A conversation with no real exchange is noise — drop it (sync's trivial gate agrees).
    if (!sawUser || !sawAssistant) return null;

    const rawBytes = new TextEncoder().encode(JSON.stringify(conv));
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rawBytes);
    const contentHash = hasher.digest("hex");

    const exportRel = relative(importsDir(), absPath);
    const session: NormalizedSession = {
      nativeId: conversationId,
      projectPath: null,
      createdAt: conv.create_time != null ? Math.round(conv.create_time * 1000) : null,
      updatedAt: conv.update_time != null ? Math.round(conv.update_time * 1000) : null,
      model: lastModel,
      sourceTitle: conv.title || null,
      kind: "chat",
      agentSpecific: {
        conversationId,
        exportFile: exportRel,
        isArchived: !!conv.is_archived,
        isStarred: !!conv.is_starred,
        url: `https://chatgpt.com/c/${conversationId}`,
      },
      messages,
    };
    return { session, contentHash, raw: rawBytes };
  },

  resolveProject(): string | null {
    return null; // web chats have no filesystem origin
  },

  buildResumeCommand(): string | null {
    return null; // not CLI-resumable; the chatgpt.com URL lives in agentSpecific
  },
};
