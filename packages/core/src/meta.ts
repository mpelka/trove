import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, or, like } from "drizzle-orm";
import { sessions, sessionMeta } from "./db/drizzle-schema.ts";

export type ResolveResult =
  | { kind: "ok"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: string[] };

/** Resolve a full id, a prefix of the id / native id, or a displayed short id
 *  (`cc·73da3fd6`, `gem·abcd1234`, …) to a single session id. The short forms are
 *  what trove prints everywhere, so every id-taking command must accept them. */
export function resolveSessionId(db: Database, ref: string): ResolveResult {
  const d = drizzle(db);
  const exact = d
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, ref))
    .get();
  if (exact) return { kind: "ok", id: exact.id };

  // Strip a short-id agent prefix (same forms lookupId accepts). `cc·73da3fd6` →
  // candidate core "73da3fd6"; gemini short ids are the TRAILING hash of the
  // `session-…` native id, so match those with a suffix-friendly LIKE too.
  const m = ref.match(/^(cc|gem|cop|agy|gpt|cw|claude-code|gemini-cli|copilot|antigravity|chatgpt|claude-web)[·:](.+)$/i);
  const candidates = m ? [ref, m[2]] : [ref];

  const seen = new Map<string, true>();
  for (const cand of candidates) {
    const rows = d
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        or(
          like(sessions.id, `${cand}%`),
          like(sessions.nativeId, `${cand}%`),
          like(sessions.nativeId, `session-%${cand}%`),
        ),
      )
      .limit(8)
      .all();
    for (const r of rows) seen.set(r.id, true);
  }
  const matches = [...seen.keys()];
  if (matches.length === 1) return { kind: "ok", id: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}

function ensureMeta(db: Database, id: string): void {
  const d = drizzle(db);
  d.insert(sessionMeta).values({ sessionId: id }).onConflictDoNothing().run();
}

export function setName(db: Database, id: string, name: string | null): void {
  ensureMeta(db, id);
  const d = drizzle(db);
  d.update(sessionMeta).set({ customName: name }).where(eq(sessionMeta.sessionId, id)).run();
}

export function setStar(db: Database, id: string, starred: boolean): void {
  ensureMeta(db, id);
  const d = drizzle(db);
  d.update(sessionMeta)
    .set({ starred: starred ? 1 : 0 })
    .where(eq(sessionMeta.sessionId, id))
    .run();
}

export function setHidden(db: Database, id: string, hidden: boolean): void {
  ensureMeta(db, id);
  const d = drizzle(db);
  d.update(sessionMeta)
    .set({ hidden: hidden ? 1 : 0 })
    .where(eq(sessionMeta.sessionId, id))
    .run();
}

export function setNotes(db: Database, id: string, notes: string | null): void {
  ensureMeta(db, id);
  const d = drizzle(db);
  d.update(sessionMeta).set({ notes }).where(eq(sessionMeta.sessionId, id)).run();
}

function getTags(db: Database, id: string): string[] {
  const d = drizzle(db);
  const row = d
    .select({ tags: sessionMeta.tags })
    .from(sessionMeta)
    .where(eq(sessionMeta.sessionId, id))
    .get();
  return row?.tags ? (JSON.parse(row.tags) as string[]) : [];
}

export function addTags(db: Database, id: string, tags: string[]): string[] {
  ensureMeta(db, id);
  const d = drizzle(db);
  const set = new Set(getTags(db, id));
  for (const t of tags) if (t.trim()) set.add(t.trim());
  const next = [...set].sort();
  d.update(sessionMeta)
    .set({ tags: JSON.stringify(next) })
    .where(eq(sessionMeta.sessionId, id))
    .run();
  return next;
}

export function removeTags(db: Database, id: string, tags: string[]): string[] {
  ensureMeta(db, id);
  const d = drizzle(db);
  const remove = new Set(tags.map((t) => t.trim()));
  const next = getTags(db, id).filter((t) => !remove.has(t));
  d.update(sessionMeta)
    .set({ tags: JSON.stringify(next) })
    .where(eq(sessionMeta.sessionId, id))
    .run();
  return next;
}
