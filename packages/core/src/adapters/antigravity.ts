import { homedir } from "node:os";
import { join, basename } from "node:path";
import { statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openReadonlyDb } from "./sqlite.ts";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
} from "./types.ts";

/**
 * Antigravity CLI (agy) adapter — sqlite medium, one database PER conversation under
 * ~/.gemini/antigravity-cli/conversations/<uuid>.db. Everything in the store is
 * protobuf blobs (no bundled schema), so extraction decodes the wire format directly
 * and pulls only the fields that probing verified across real conversations:
 *
 *   steps(idx, step_type, metadata, step_payload, …) where
 *     step_type 14 → user message:      payload field 19 → sub-field 2 (string)
 *     step_type 15 → assistant message: payload field 20 → sub-field 1 (string);
 *                    sub-field 3 is model thinking → dropped
 *     other types  → tool steps:        payload field 5 → sub-field 30/31 = human
 *                    title ("List directory contents") → kept as a `[used: …]` marker
 *   per-step timestamp: metadata field 1 = google.protobuf.Timestamp {1: sec, 2: ns}
 *   trajectory_meta(trajectory_id, cascade_id) — cascade_id == db filename stem
 *   trajectory_metadata_blob(id='main').data field 1 → sub-field 1 = workspace
 *     file:// URI → projectPath
 *
 * Unknown/undecodable blobs are skipped silently — fail-soft is the contract.
 * The DBs are WAL-mode; fresh steps may sit in the -wal sidecar before checkpoint,
 * so the change fingerprint (sizeBytes/mtimeMs) folds the sidecar's stat in too.
 */

const STEP_TYPE_USER = 14;
const STEP_TYPE_ASSISTANT = 15;

/** Discovery root. `TROVE_AGY_ROOT` overrides `~/.gemini/antigravity-cli`;
 *  read per call (not at module load) so tests can point it at a fixture dir. */
function agyRoot(): string {
  return process.env.TROVE_AGY_ROOT || join(homedir(), ".gemini", "antigravity-cli");
}

function conversationsDir(): string {
  return join(agyRoot(), "conversations");
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire-format reader (read-only, fail-soft). Enough to walk
// tag/varint/length-delimited structure; unknown wire types abort the message.
// ---------------------------------------------------------------------------

interface FieldVal {
  varint?: bigint;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, i: number): [bigint, number] | null {
  let r = 0n;
  let s = 0n;
  for (let n = 0; n < 10 && i < buf.length; n++, i++) {
    const b = buf[i]!;
    r |= BigInt(b & 0x7f) << s;
    if ((b & 0x80) === 0) return [r, i + 1];
    s += 7n;
  }
  return null;
}

/** Decode one message level into fieldNo → values; null if it isn't a valid message. */
function protoFields(buf: Uint8Array): Map<number, FieldVal[]> | null {
  const out = new Map<number, FieldVal[]>();
  let i = 0;
  while (i < buf.length) {
    const v = readVarint(buf, i);
    if (!v) return null;
    const [tag, ni] = v;
    i = ni;
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo === 0 || fieldNo > 100_000) return null;
    let val: FieldVal;
    if (wire === 0) {
      const vv = readVarint(buf, i);
      if (!vv) return null;
      val = { varint: vv[0] };
      i = vv[1];
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      val = { bytes: buf.subarray(i, i + 8) };
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      val = { bytes: buf.subarray(i, i + 4) };
      i += 4;
    } else if (wire === 2) {
      const lv = readVarint(buf, i);
      if (!lv) return null;
      const len = Number(lv[0]);
      i = lv[1];
      if (i + len > buf.length) return null;
      val = { bytes: buf.subarray(i, i + len) };
      i += len;
    } else {
      return null;
    }
    let list = out.get(fieldNo);
    if (!list) out.set(fieldNo, (list = []));
    list.push(val);
  }
  return out;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function protoString(v: FieldVal | undefined): string | null {
  if (!v?.bytes) return null;
  try {
    return utf8Strict.decode(v.bytes);
  } catch {
    return null; // binary, not text
  }
}

/** Nested message at `fieldNo` (first occurrence), or null. */
function subMessage(f: Map<number, FieldVal[]>, fieldNo: number): Map<number, FieldVal[]> | null {
  const b = f.get(fieldNo)?.[0]?.bytes;
  return b ? protoFields(b) : null;
}

/** metadata field 1 is a google.protobuf.Timestamp — epoch ms, or null. */
function stepTimestamp(metadata: Uint8Array | null): number | null {
  if (!metadata) return null;
  const f = protoFields(metadata);
  if (!f) return null;
  const t = subMessage(f, 1);
  const sec = t?.get(1)?.[0]?.varint;
  if (sec == null) return null;
  const nanos = t?.get(2)?.[0]?.varint ?? 0n;
  const ms = Number(sec) * 1000 + Math.floor(Number(nanos) / 1e6);
  // Sanity: a plausible wall-clock (2001-01-01 .. 2100-01-01), not some other varint.
  return ms > 978_307_200_000 && ms < 4_102_444_800_000 ? ms : null;
}

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  step_payload: Uint8Array | null;
}

function b64(u8: Uint8Array | null): string | null {
  return u8 ? Buffer.from(u8).toString("base64") : null;
}

export const antigravityAdapter: Adapter = {
  agentId: "antigravity",

  discoverLocations() {
    return [conversationsDir()];
  },

  async enumerate(): Promise<SourceRef[]> {
    const dir = conversationsDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return []; // dir absent → no sessions
    }
    const refs: SourceRef[] = [];
    for (const name of entries) {
      if (!name.endsWith(".db")) continue; // skips -wal / -shm sidecars too
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      // WAL: unflushed steps live in the sidecar; fold it into the fingerprint so a
      // conversation that grew (wal only) still fails the fast gate and re-parses.
      let size = st.size;
      let mtime = st.mtimeMs;
      try {
        const wal = statSync(`${path}-wal`);
        size += wal.size;
        mtime = Math.max(mtime, wal.mtimeMs);
      } catch {}
      refs.push({
        agent: this.agentId,
        medium: "sqlite",
        path,
        dbRowId: name.replace(/\.db$/, ""),
        sizeBytes: size,
        mtimeMs: Math.floor(mtime),
        nativeIdHint: name.replace(/\.db$/, ""),
      });
    }
    return refs;
  },

  async parse(ref: SourceRef): Promise<ParseResult | null> {
    const db = openReadonlyDb(ref.path);
    if (!db) return null;

    let stepRows: StepRow[];
    let trajMeta: { trajectory_id: string | null; cascade_id: string | null } | undefined;
    let metaBlob: Uint8Array | null = null;
    try {
      stepRows = db
        .query(
          "SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx",
        )
        .all() as StepRow[];
      trajMeta = db
        .query("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1")
        .get() as typeof trajMeta;
      const blobRow = db
        .query("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get() as { data: Uint8Array | null } | undefined;
      metaBlob = blobRow?.data ?? null;
    } catch {
      return null; // not an agy conversation DB (or unreadable) → fail soft
    } finally {
      db.close();
    }

    const messages: NormalizedMessage[] = [];
    let seq = 0;
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (const row of stepRows) {
      const payload = row.step_payload ? protoFields(new Uint8Array(row.step_payload)) : null;
      if (!payload) continue;
      const ts = stepTimestamp(row.metadata ? new Uint8Array(row.metadata) : null);
      if (ts != null) {
        minTs = Math.min(minTs, ts);
        maxTs = Math.max(maxTs, ts);
      }

      let role: NormalizedMessage["role"];
      let text: string;
      let toolCalls: NormalizedMessage["toolCalls"];
      if (row.step_type === STEP_TYPE_USER) {
        const t = protoString(subMessage(payload, 19)?.get(2)?.[0])?.trim() ?? "";
        if (!t) continue;
        role = "user";
        text = t;
      } else if (row.step_type === STEP_TYPE_ASSISTANT) {
        // field 20.1 = visible response; 20.3 = thinking (dropped); 20.6 = bot id
        const t = protoString(subMessage(payload, 20)?.get(1)?.[0])?.trim() ?? "";
        if (!t) continue; // pure planning/thinking step → skip
        role = "assistant";
        text = t;
      } else {
        // Tool steps: keep the human-readable title as a compact marker, drop bodies.
        const header = subMessage(payload, 5);
        const title =
          protoString(header?.get(30)?.[0])?.trim() || protoString(header?.get(31)?.[0])?.trim();
        if (!title) continue; // internal/undecodable step → skip
        role = "tool";
        text = `[used: ${title}]`;
        // agy has no separate command/input — the human title IS the descriptor. Carry it
        // as the tool name so the GUI expand shows the same per-step title, one per step.
        toolCalls = [{ name: title, input: "" }];
      }

      messages.push({
        uid: `step-${row.idx}`,
        seq: seq++,
        role,
        parentUid: null, // parent_references exists but has been empty on real stores
        timestamp: ts,
        text,
        ...(toolCalls ? { toolCalls } : {}),
      });
    }

    // projectPath from the workspace file:// URI in the 'main' metadata blob.
    let projectPath: string | null = null;
    let workspaceUri: string | null = null;
    if (metaBlob) {
      const f = protoFields(new Uint8Array(metaBlob));
      const uri = f ? protoString(subMessage(f, 1)?.get(1)?.[0]) : null;
      if (uri && uri.startsWith("file://")) {
        workspaceUri = uri;
        try {
          projectPath = fileURLToPath(uri);
        } catch {}
      }
    }

    // `raw`: JSON of the raw step rows (blobs base64) — a faithful, deterministic
    // serialization for --keep-raw; also the contentHash input.
    const rawJson = JSON.stringify({
      trajectoryMeta: trajMeta ?? null,
      steps: stepRows.map((r) => ({
        idx: r.idx,
        step_type: r.step_type,
        status: r.status,
        metadata: b64(r.metadata ? new Uint8Array(r.metadata) : null),
        step_payload: b64(r.step_payload ? new Uint8Array(r.step_payload) : null),
      })),
    });
    const rawBytes = new TextEncoder().encode(rawJson);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rawBytes);
    const contentHash = hasher.digest("hex");

    let st: { mtimeMs: number } | null = null;
    try {
      st = statSync(ref.path);
    } catch {}
    const fallbackTs = st ? Math.floor(st.mtimeMs) : null;

    // Identity is the db filename stem (== cascade_id on every probed store) — one
    // conversation per file, unique. trajectory_id kept for later grouping.
    const nativeId = basename(ref.path).replace(/\.db$/, "");
    const session: NormalizedSession = {
      nativeId,
      projectPath,
      createdAt: Number.isFinite(minTs) ? minTs : fallbackTs,
      updatedAt: Number.isFinite(maxTs) ? maxTs : fallbackTs,
      model: null, // not cleanly recoverable from the protobuf blobs
      sourceTitle: null,
      kind: null,
      agentSpecific: {
        dbPath: ref.path,
        trajectoryId: trajMeta?.trajectory_id ?? null,
        cascadeId: trajMeta?.cascade_id ?? null,
        workspaceUri,
      },
      messages,
    };
    return { session, contentHash, raw: rawBytes };
  },

  resolveProject(session: NormalizedSession): string | null {
    return session.projectPath ?? null;
  },

  buildResumeCommand(): string | null {
    // TODO: agy's resume story (if any) is undocumented — no verified flag to
    // reattach to a conversation db by id. Revisit when the CLI exposes one.
    return null;
  },
};
