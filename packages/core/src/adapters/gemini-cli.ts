import { Glob } from "bun";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { statSync, readFileSync } from "node:fs";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
} from "./types.ts";

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

export const geminiCliAdapter: Adapter = {
  agentId: "gemini-cli",

  discoverLocations() {
    return [tmpDir()];
  },

  async enumerate(): Promise<SourceRef[]> {
    const root = tmpDir();
    const refs: SourceRef[] = [];
    // One JSON per session under ~/.gemini/tmp/<project>/chats/session-*.json.
    // Some chats dirs are empty — that's fine, the glob just yields nothing there.
    const glob = new Glob("*/chats/session-*.json");
    try {
      for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
        const path = join(root, rel);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        refs.push({
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
    return refs;
  },

  async parse(ref: SourceRef): Promise<ParseResult | null> {
    const bytes = await Bun.file(ref.path).bytes();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const contentHash = hasher.digest("hex");

    let root: any;
    try {
      root = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null; // fail soft on a corrupt file
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
    const nativeId = basename(ref.path).replace(/\.json$/, "");
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

  buildResumeCommand(): string | null {
    // TODO: gemini resume needs `--session-file <rawpath>` plumbing that doesn't
    // exist yet. `gemini --session-file` is the robust resume path — wire it later.
    return null;
  },
};
