import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { openReadonlyDb } from "./sqlite.ts";
import type {
  Adapter,
  NormalizedMessage,
  NormalizedSession,
  ParseResult,
  SourceRef,
} from "./types.ts";

/**
 * GitHub Copilot CLI adapter — the first sqlite-medium source. ALL sessions live in
 * ONE shared database (~/.copilot/session-store.db), so a SourceRef can't be "a file":
 *
 *  - `path` is the synthetic identity `<dbfile>::<sessionId>` — unique per session,
 *    opaque to core (sync only compares it, never stats it).
 *  - `mtimeMs`/`sizeBytes` are a per-session change fingerprint from the DB itself
 *    (max of the session's timestamps / total turn text bytes), NOT the shared file's
 *    stat — the file's mtime changes whenever ANY session changes, which would
 *    re-parse every session on every sync.
 *
 * Schema (v1.0.67): sessions(id, cwd, repository, host_type, branch, summary,
 * created_at, updated_at) + turns(session_id, turn_index, user_message,
 * assistant_response, timestamp). Turn text is plain prose (no JSON envelopes);
 * tool traffic isn't stored in turns, so there's nothing to slim away.
 */

const DB_FILENAME = "session-store.db";
const PATH_SEP = "::";

/** Discovery root. `TROVE_COPILOT_ROOT` overrides the default `~/.copilot`;
 *  read per call (not at module load) so tests can point it at a fixture dir. */
function copilotRoot(): string {
  return process.env.TROVE_COPILOT_ROOT || join(homedir(), ".copilot");
}

function storePath(): string {
  return join(copilotRoot(), DB_FILENAME);
}

/** Timestamps are ISO strings in practice, but the schema default is SQLite's
 *  `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC, no zone) — handle both. */
function parseTs(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  let t = Date.parse(s);
  if (Number.isNaN(t) || !s.includes("T")) {
    const iso = Date.parse(s.replace(" ", "T") + "Z");
    if (!Number.isNaN(iso)) return iso;
  }
  return Number.isNaN(t) ? null : t;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  host_type: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface TurnRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const copilotAdapter: Adapter = {
  agentId: "copilot",

  discoverLocations() {
    return [storePath()];
  },

  async enumerate(): Promise<SourceRef[]> {
    const dbFile = storePath();
    try {
      statSync(dbFile);
    } catch {
      return []; // no store → no sessions
    }
    const db = openReadonlyDb(dbFile);
    if (!db) return []; // locked/corrupt → fail soft, try again next sync

    const refs: SourceRef[] = [];
    try {
      // Per-session fingerprint in one pass: latest activity timestamp + total turn
      // text bytes. A new turn moves both; an in-place edit moves at least one.
      const rows = db
        .query(
          `SELECT s.id AS id, s.created_at AS created_at, s.updated_at AS updated_at,
                  COUNT(t.id) AS turn_count,
                  MAX(t.timestamp) AS last_turn_at,
                  COALESCE(SUM(LENGTH(COALESCE(t.user_message,'')) +
                               LENGTH(COALESCE(t.assistant_response,''))), 0) AS content_bytes
           FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
           GROUP BY s.id`,
        )
        .all() as Array<{
        id: string;
        created_at: string | null;
        updated_at: string | null;
        turn_count: number;
        last_turn_at: string | null;
        content_bytes: number;
      }>;
      for (const r of rows) {
        if (typeof r.id !== "string" || !r.id) continue;
        if (!r.turn_count) continue; // turnless shells (aborted starts) → nothing to ingest
        const candidates = [parseTs(r.created_at), parseTs(r.updated_at), parseTs(r.last_turn_at)]
          .filter((t): t is number => t != null);
        refs.push({
          agent: this.agentId,
          medium: "sqlite",
          path: `${dbFile}${PATH_SEP}${r.id}`,
          dbRowId: r.id,
          sizeBytes: r.content_bytes,
          mtimeMs: candidates.length ? Math.max(...candidates) : 0,
          nativeIdHint: r.id,
        });
      }
    } catch {
      // schema drift / read error → no refs this run
    } finally {
      db.close();
    }
    return refs;
  },

  async parse(ref: SourceRef): Promise<ParseResult | null> {
    // Recover (dbfile, sessionId) from the synthetic path; dbRowId is authoritative.
    const sep = ref.path.lastIndexOf(PATH_SEP);
    const dbFile = sep >= 0 ? ref.path.slice(0, sep) : ref.path;
    const sessionId = ref.dbRowId ?? (sep >= 0 ? ref.path.slice(sep + PATH_SEP.length) : "");
    if (!sessionId) return null;

    const db = openReadonlyDb(dbFile);
    if (!db) return null;

    let sessionRow: SessionRow | undefined;
    let turnRows: TurnRow[];
    try {
      sessionRow = db
        .query(
          "SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions WHERE id = ?",
        )
        .get(sessionId) as SessionRow | undefined;
      if (!sessionRow) return null;
      turnRows = db
        .query(
          "SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index",
        )
        .all(sessionId) as TurnRow[];
    } catch {
      return null; // schema drift / read error → fail soft
    } finally {
      db.close();
    }

    const messages: NormalizedMessage[] = [];
    let seq = 0;
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const t of turnRows) {
      const ts = parseTs(t.timestamp);
      if (ts != null) {
        minTs = Math.min(minTs, ts);
        maxTs = Math.max(maxTs, ts);
      }
      const user = typeof t.user_message === "string" ? t.user_message.trim() : "";
      const asst = typeof t.assistant_response === "string" ? t.assistant_response.trim() : "";
      if (user) {
        messages.push({
          uid: `t${t.turn_index}-user`,
          seq: seq++,
          role: "user",
          parentUid: null,
          timestamp: ts,
          text: user,
        });
      }
      if (asst) {
        messages.push({
          uid: `t${t.turn_index}-assistant`,
          seq: seq++,
          role: "assistant",
          parentUid: null,
          timestamp: ts,
          text: asst,
        });
      }
    }

    // `raw` is a faithful JSON serialization of the session's raw rows (there is no
    // per-session byte range in a shared DB to archive). Also the contentHash input —
    // deterministic (stable key order from the row shapes above).
    const rawJson = JSON.stringify({ session: sessionRow, turns: turnRows });
    const rawBytes = new TextEncoder().encode(rawJson);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rawBytes);
    const contentHash = hasher.digest("hex");

    const createdAt = parseTs(sessionRow.created_at) ?? (Number.isFinite(minTs) ? minTs : null);
    const updatedCandidates = [parseTs(sessionRow.updated_at), Number.isFinite(maxTs) ? maxTs : null]
      .filter((t): t is number => t != null);
    const updatedAt = updatedCandidates.length ? Math.max(...updatedCandidates) : createdAt;

    const summary =
      typeof sessionRow.summary === "string" && sessionRow.summary.trim()
        ? sessionRow.summary.trim()
        : null;

    const session: NormalizedSession = {
      nativeId: sessionId,
      projectPath: typeof sessionRow.cwd === "string" && sessionRow.cwd ? sessionRow.cwd : null,
      createdAt,
      updatedAt,
      model: null, // not recorded in the store
      sourceTitle: summary,
      kind: null,
      agentSpecific: {
        dbPath: dbFile,
        repository: sessionRow.repository,
        branch: sessionRow.branch,
        hostType: sessionRow.host_type,
      },
      messages,
    };
    return { session, contentHash, raw: rawBytes };
  },

  resolveProject(session: NormalizedSession): string | null {
    return session.projectPath ?? null;
  },

  buildResumeCommand(input): string | null {
    if (!input.nativeId) return null;
    const cd = input.projectPath ? `cd ${shellQuote(input.projectPath)} && ` : "";
    return `${cd}copilot --resume=${input.nativeId}`;
  },
};
