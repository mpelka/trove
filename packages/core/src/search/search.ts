import type { Database } from "bun:sqlite";
import { parseQuery } from "./query.ts";

export interface SearchOptions {
  query: string;
  agent?: string;
  limit?: number;
  exact?: boolean;
  sort?: "relevance" | "recent"; // relevance = bm25 (default), recent = message time desc
  star?: boolean;
  project?: string;
  tag?: string;
  since?: number; // epoch ms
  until?: number;
}

export interface SearchHit {
  messageId: number;
  sessionId: string;
  seq: number;
  role: string;
  timestamp: number | null;
  snippet: string;
  score: number;
  agent: string;
  projectPath: string | null;
  title: string | null;
  customName: string | null;
  starred: boolean;
  sourceGone: boolean;
}

export interface SessionHit {
  sessionId: string;
  agent: string;
  projectPath: string | null;
  title: string | null;
  customName: string | null;
  starred: boolean;
  sourceGone: boolean;
  matchCount: number;
  bestScore: number;
  bestSnippet: string;
  bestTimestamp: number | null;
}

/**
 * Build an FTS5 MATCH expression from a user query (see query.ts for the grammar).
 * Every term/phrase is individually double-quoted, so arbitrary user input can never
 * produce an FTS5 syntax error. --exact = the whole query is one phrase.
 *
 * Phrase boost: a purely-unquoted query of 3+ surviving words becomes
 * `("w1 w2 w3") OR ("w1" "w2" "w3")` — bm25 sums over ALL phrases in the query
 * expression, so rows matching the exact-phrase branch score strictly better than
 * rows that only match the scattered terms.
 */
export function buildMatch(query: string, exact: boolean): string {
  const q = query.trim();
  if (!q) return '""';
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  if (exact) return quote(q);
  const { phrases, terms, prefixLast } = parseQuery(query);
  const parts = phrases.map(quote);
  terms.forEach((t, idx) => {
    parts.push(quote(t) + (prefixLast && idx === terms.length - 1 ? "*" : ""));
  });
  if (parts.length === 0) return '""'; // e.g. a lone `"` — matches nothing
  const base = parts.join(" ");
  if (phrases.length === 0 && terms.length >= 3) {
    // `"a b c"*` is valid FTS5: the trailing star makes the phrase's LAST token a prefix.
    return `(${quote(terms.join(" "))}${prefixLast ? "*" : ""}) OR (${base})`;
  }
  return base;
}

const BASE_SQL = `
SELECT m.id AS messageId, m.session_id AS sessionId, m.seq AS seq, m.role AS role,
       m.timestamp AS timestamp,
       snippet(messages_fts, 0, '«', '»', ' … ', 18) AS snippet,
       bm25(messages_fts) AS score,
       s.agent AS agent, s.project_path AS projectPath, s.source_title AS title,
       s.source_gone AS sourceGone,
       meta.custom_name AS customName, COALESCE(meta.starred, 0) AS starred
FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
JOIN sessions s ON s.id = m.session_id
LEFT JOIN session_meta meta ON meta.session_id = s.id
`;

interface RawRow {
  messageId: number;
  sessionId: string;
  seq: number;
  role: string;
  timestamp: number | null;
  snippet: string;
  score: number;
  agent: string;
  projectPath: string | null;
  title: string | null;
  sourceGone: number;
  customName: string | null;
  starred: number;
}

function buildWhere(opts: SearchOptions): { where: string[]; params: unknown[] } {
  const where: string[] = ["messages_fts MATCH ?"];
  const params: unknown[] = [buildMatch(opts.query, opts.exact ?? false)];
  if (opts.agent) {
    where.push("s.agent = ?");
    params.push(opts.agent);
  }
  if (opts.star) where.push("COALESCE(meta.starred, 0) = 1");
  if (opts.project) {
    where.push("s.project_path LIKE ?");
    params.push(`%${opts.project}%`);
  }
  if (opts.tag) {
    where.push("meta.tags LIKE ?");
    params.push(`%"${opts.tag}"%`);
  }
  if (typeof opts.since === "number") {
    where.push("m.timestamp >= ?");
    params.push(opts.since);
  }
  if (typeof opts.until === "number") {
    where.push("m.timestamp <= ?");
    params.push(opts.until);
  }
  return { where, params };
}

function runQuery(db: Database, opts: SearchOptions, cap: number): RawRow[] {
  const { where, params } = buildWhere(opts);
  const orderBy = opts.sort === "recent" ? "m.timestamp DESC" : "score";
  const sql = `${BASE_SQL} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`;
  params.push(cap);
  return db.query(sql).all(...(params as any[])) as RawRow[];
}

/** Exact per-session match counts over the FULL result set — the over-fetched,
 *  score-ordered rows would otherwise silently cap matchCount (e.g. "250×" for 600). */
function countsBySession(db: Database, opts: SearchOptions): Map<string, number> {
  const { where, params } = buildWhere(opts);
  const sql = `
    SELECT m.session_id AS sessionId, COUNT(*) AS n
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_id
    LEFT JOIN session_meta meta ON meta.session_id = s.id
    WHERE ${where.join(" AND ")}
    GROUP BY m.session_id`;
  const rows = db.query(sql).all(...(params as any[])) as { sessionId: string; n: number }[];
  return new Map(rows.map((r) => [r.sessionId, r.n]));
}

function toHit(r: RawRow): SearchHit {
  return {
    messageId: r.messageId,
    sessionId: r.sessionId,
    seq: r.seq,
    role: r.role,
    timestamp: r.timestamp,
    snippet: r.snippet,
    score: r.score,
    agent: r.agent,
    projectPath: r.projectPath,
    title: r.title,
    customName: r.customName,
    starred: !!r.starred,
    sourceGone: !!r.sourceGone,
  };
}

export function searchMessages(db: Database, opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 20;
  return runQuery(db, opts, limit).map(toHit);
}

export function searchSessions(db: Database, opts: SearchOptions): SessionHit[] {
  const limit = opts.limit ?? 20;
  // Over-fetch (rows are score-ordered) for best-snippet/best-score per session;
  // exact match counts come from a separate GROUP BY over the full match set.
  const cap = Math.max(limit * 25, 250);
  const rows = runQuery(db, opts, cap);
  const counts = countsBySession(db, opts);
  const bySession = new Map<string, SessionHit>();
  for (const r of rows) {
    if (bySession.has(r.sessionId)) continue;
    bySession.set(r.sessionId, {
      sessionId: r.sessionId,
      agent: r.agent,
      projectPath: r.projectPath,
      title: r.title,
      customName: r.customName,
      starred: !!r.starred,
      sourceGone: !!r.sourceGone,
      matchCount: counts.get(r.sessionId) ?? 1,
      bestScore: r.score,
      bestSnippet: r.snippet,
      bestTimestamp: r.timestamp,
    });
  }
  const sessions = [...bySession.values()];
  if (opts.sort === "recent") {
    sessions.sort((a, b) => (b.bestTimestamp ?? 0) - (a.bestTimestamp ?? 0));
  } else {
    sessions.sort((a, b) => a.bestScore - b.bestScore);
  }
  return sessions.slice(0, limit);
}
