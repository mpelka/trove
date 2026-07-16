// Which agent filter chips does the sidebar render? — PURE decision logic, no React.
//
// Chips are CHROME, not data: hiding a chip never filters a query. "all" view,
// search, and session jumps always cover every agent — this module only decides
// which one-click filters are worth screen space on THIS machine.
//
// Rules (in order):
//   1. The ACTIVE agent filter always shows its chip, even if auto- or manually
//      hidden — a deep link like ?agent=copilot must stay legible.
//   2. Agents with zero sessions in the store are auto-hidden.
//   3. Agents the user manually unchecked (settings menu) are hidden.
//   4. While counts are still loading (undefined), nothing is auto-hidden — the
//      set only ever SHRINKS once data arrives, so chips don't pop in late.
// Order of the result always follows `known` (the canonical chip order).

export type AgentSessionCount = { agent: string; sessions: number };

export function visibleAgentChips(opts: {
  /** Canonical chip order — the same AGENTS list the palette uses. */
  known: readonly string[];
  /** Per-agent session counts from trpc.status (undefined while loading). */
  counts: readonly AgentSessionCount[] | undefined;
  /** Agents manually unchecked in the settings menu (persisted per machine). */
  hidden: ReadonlySet<string>;
  /** Currently-active agent filter (null = all). */
  active: string | null;
}): string[] {
  const { known, counts, hidden, active } = opts;
  const hasSessions = (id: string) =>
    counts === undefined || counts.some((c) => c.agent === id && c.sessions > 0);
  return known.filter((id) => id === active || (hasSessions(id) && !hidden.has(id)));
}

// ── localStorage round-trip for the manual-hidden set ───────────────────────
// Storage is the caller's job (same try/catch idiom as rail.tsx's readVar); these
// two keep the serialization format in one testable place. Anything malformed
// parses as "nothing hidden" — failing open never hides a chip by accident.

export const HIDDEN_AGENTS_KEY = "trove-hidden-agents";

export function parseHiddenAgents(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const val = JSON.parse(raw);
    if (!Array.isArray(val)) return new Set();
    return new Set(val.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function serializeHiddenAgents(hidden: ReadonlySet<string>): string {
  return JSON.stringify([...hidden].sort());
}
