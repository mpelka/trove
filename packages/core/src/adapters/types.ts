/**
 * The central abstraction: one adapter per agent, contract is *records out, not files in*.
 * A source may be a directory of files OR a database, so discovery is medium-neutral.
 */

export type Medium = "file" | "sqlite";

/** A pointer to one session artifact — a file path, or (later) a (db, rowId) pair. */
export interface SourceRef {
  agent: string;
  medium: Medium;
  path: string; // file path, or db file path for sqlite sources
  dbRowId?: string; // set for sqlite sources
  sizeBytes: number;
  mtimeMs: number;
  nativeIdHint?: string;
}

/** One compact per-tool_use record: the tool name + a short input descriptor.
 *  Large blob fields (file bodies, new/old_string, content) are never captured. */
export interface ToolCall {
  name: string;
  input: string;
}

export interface NormalizedMessage {
  uid?: string | null;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  parentUid?: string | null;
  timestamp?: number | null; // epoch ms
  text: string;
  // One entry per tool_use block in order (NOT deduped like `text`). Absent for
  // non-tool messages. Serialized to the `tool_calls` JSON column at the sync boundary.
  toolCalls?: ToolCall[];
}

export interface NormalizedSession {
  nativeId: string;
  projectPath?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  model?: string | null;
  sourceTitle?: string | null;
  kind?: string | null;
  agentSpecific?: Record<string, unknown>;
  messages: NormalizedMessage[];
}

export interface ParseResult {
  session: NormalizedSession;
  contentHash: string; // sha256 of the raw source, for change detection
  raw?: Uint8Array; // raw bytes, for the optional gzipped archive
}

export interface Adapter {
  agentId: string;
  /** Where this tool keeps sessions on this machine (may be several). */
  discoverLocations(): string[];
  /** Find session artifacts. Recognition is the adapter's job, not the core's. */
  enumerate(): Promise<SourceRef[]>;
  /** Map one raw source to the common shape; null to skip. */
  parse(ref: SourceRef): Promise<ParseResult | null>;
  /** Best-effort origin repo/worktree path (may be gone). */
  resolveProject?(session: NormalizedSession): string | null;
  /** How to resume this tool's session; absent if unsupported. */
  buildResumeCommand?(input: {
    nativeId: string;
    projectPath?: string | null;
    rawPath?: string | null;
  }): string | null;
}
