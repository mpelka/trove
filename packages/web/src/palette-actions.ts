// Command-palette registry + fuzzy session filter — PURE data/functions, no React.
// The palette component (command-palette.tsx) renders whatever this module says is
// visible; unit tests (palette-actions.test.ts) exercise the predicates and the
// fuzzy matcher without rendering anything.

import { agentLabel } from "@trove/core/format";

// ── platform / shortcut hint ────────────────────────────────────────────────

/** True for macOS-ish platforms (the user runs macOS at home, WSL/Linux at work). */
export function isMacLike(platformOrUA: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platformOrUA);
}

export function shortcutHint(mac: boolean): string {
  return mac ? "⌘K" : "Ctrl K";
}

// ── fuzzy matching ──────────────────────────────────────────────────────────

const WORD_START = /[\s\-_./:,()[\]#"'`]/;

/** Case-insensitive subsequence match. Returns a score (higher = better) or null
 *  when `query` is not a subsequence of `text`. Contiguous runs and word-boundary
 *  hits score extra, so "raw view" beats "R…a…w in scattered places". */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let qi = 0;
  let prev = -2;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    score += 1;
    if (ti === prev + 1) score += 2; // contiguous run
    if (ti === 0 || WORD_START.test(t[ti - 1]!)) score += 3; // word start
    prev = ti;
    qi++;
  }
  return qi === q.length ? score : null;
}

export type SessionLite = { id: string; name: string };

/** Rank the already-loaded session list against a palette query. Ties break toward
 *  shorter names (the match covers more of them). Empty query → no jump rows. */
export function fuzzyFilterSessions<T extends SessionLite>(sessions: T[], query: string, limit = 6): T[] {
  const q = query.trim();
  if (!q) return [];
  const scored: { s: T; score: number }[] = [];
  for (const s of sessions) {
    const score = fuzzyScore(q, s.name);
    if (score != null) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
  return scored.slice(0, limit).map((x) => x.s);
}

// ── action registry ─────────────────────────────────────────────────────────

/** Everything an action's visibility/label may depend on — a snapshot of app state. */
export type PaletteCtx = {
  agent: string | null; // active agent filter (null = all)
  /** Agent ids whose sidebar chips are visible on this machine (see chip-visibility.ts).
   *  Palette "Filter: X" actions mirror the chips — a hidden chip has no action either. */
  visibleAgents: string[];
  starOnly: boolean;
  hlView: boolean;
  searching: boolean; // left-pane query is non-empty
  bsort: "updated" | "created"; // browse sort
  order: "desc" | "asc";
  sort: "relevance" | "recent"; // search sort
  sessionOpen: boolean;
  rawOpen: boolean;
  expandAll: boolean;
  infoOpen: boolean;
  theme: "light" | "dark";
};

/** The side-effect surface actions run against — App wires these to real state. */
export type PaletteHandlers = {
  setAgent(agent: string | undefined): void;
  toggleStarred(): void;
  toggleHighlights(): void;
  setBsort(v: "updated" | "created"): void;
  setOrder(v: "desc" | "asc"): void;
  setSort(v: "relevance" | "recent"): void;
  clearSearch(): void;
  sync(): void;
  toggleTheme(): void;
  toggleExpand(): void;
  toggleRaw(): void;
  toggleInfo(): void;
};

export type PaletteAction = {
  id: string;
  group: "filters" | "sort" | "session" | "app";
  label(ctx: PaletteCtx): string;
  visible(ctx: PaletteCtx): boolean;
  run(ctx: PaletteCtx, h: PaletteHandlers): void;
};

export const PALETTE_GROUPS: { id: PaletteAction["group"]; heading: string }[] = [
  { id: "filters", heading: "Filters" },
  { id: "sort", heading: "Sort" },
  { id: "session", heading: "Session" },
  { id: "app", heading: "App" },
];

// Same agent set (and friendly names) as the sidebar's filter chips.
// `chip` is the short chip label; `name` is the full product name (settings menu).
export const AGENTS: { id: string; chip: string; name: string }[] = [
  { id: "claude-code", chip: "claude", name: "Claude Code" },
  { id: "gemini-cli", chip: "gemini", name: "Gemini CLI" },
  { id: "copilot", chip: "copilot", name: "GitHub Copilot" },
  { id: "antigravity", chip: "agy", name: "Antigravity" },
  { id: "chatgpt", chip: "chatgpt", name: "ChatGPT" },
  { id: "claude-web", chip: "claude.ai", name: "Claude.ai" },
];

/** Full product name for an agent id; null for ids outside the registry
 *  (callers fall back to the short agentLabel so unknown agents still render). */
export function agentName(id: string): string | null {
  return AGENTS.find((a) => a.id === id)?.name ?? null;
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  // ── filters ──
  {
    id: "filter-agent-all",
    group: "filters",
    label: () => "Show all agents",
    visible: (ctx) => ctx.agent != null,
    run: (_ctx, h) => h.setAgent(undefined),
  },
  ...AGENTS.map(
    (a): PaletteAction => ({
      id: `filter-agent-${a.id}`,
      group: "filters",
      label: () => `Filter: ${a.chip} (${agentLabel(a.id)})`,
      // Mirrors the sidebar chips: no chip on this machine → no palette action.
      // (The already-active agent needs no action; "Show all agents" stays regardless.)
      visible: (ctx) => ctx.agent !== a.id && ctx.visibleAgents.includes(a.id),
      run: (_ctx, h) => h.setAgent(a.id),
    }),
  ),
  {
    id: "toggle-starred",
    group: "filters",
    label: (ctx) => (ctx.starOnly ? "Starred only: off" : "Show starred only"),
    visible: () => true,
    run: (_ctx, h) => h.toggleStarred(),
  },
  {
    id: "toggle-highlights",
    group: "filters",
    label: (ctx) => (ctx.hlView ? "Exit highlights view" : "Browse highlights"),
    visible: () => true,
    run: (_ctx, h) => h.toggleHighlights(),
  },
  // The rail's search trigger no longer shows the query text (just an accent dot),
  // so clearing an active search must stay one ⌘K away.
  {
    id: "clear-search",
    group: "filters",
    label: () => "Clear search",
    visible: (ctx) => ctx.searching,
    run: (_ctx, h) => h.clearSearch(),
  },
  // ── sort (browse sort only makes sense when the list isn't showing search hits) ──
  {
    id: "sort-created",
    group: "sort",
    label: () => "Sort by created date",
    visible: (ctx) => !ctx.searching && ctx.bsort === "updated",
    run: (_ctx, h) => h.setBsort("created"),
  },
  {
    id: "sort-updated",
    group: "sort",
    label: () => "Sort by last activity",
    visible: (ctx) => !ctx.searching && ctx.bsort === "created",
    run: (_ctx, h) => h.setBsort("updated"),
  },
  {
    id: "order-toggle",
    group: "sort",
    label: (ctx) => (ctx.order === "desc" ? "Order: oldest first" : "Order: newest first"),
    visible: (ctx) => !ctx.searching,
    run: (ctx, h) => h.setOrder(ctx.order === "desc" ? "asc" : "desc"),
  },
  {
    id: "search-sort-relevance",
    group: "sort",
    label: () => "Sort results by best match",
    visible: (ctx) => ctx.searching && ctx.sort === "recent",
    run: (_ctx, h) => h.setSort("relevance"),
  },
  {
    id: "search-sort-recent",
    group: "sort",
    label: () => "Sort results by recent",
    visible: (ctx) => ctx.searching && ctx.sort === "relevance",
    run: (_ctx, h) => h.setSort("recent"),
  },
  // ── session (only when a conversation is open) ──
  {
    id: "expand-toggle",
    group: "session",
    label: (ctx) => (ctx.expandAll ? "Collapse all messages" : "Expand all messages"),
    visible: (ctx) => ctx.sessionOpen && !ctx.rawOpen,
    run: (_ctx, h) => h.toggleExpand(),
  },
  {
    id: "raw-toggle",
    group: "session",
    label: (ctx) => (ctx.rawOpen ? "Back to conversation" : "Open raw source"),
    visible: (ctx) => ctx.sessionOpen,
    run: (_ctx, h) => h.toggleRaw(),
  },
  {
    id: "info-toggle",
    group: "session",
    label: (ctx) => (ctx.infoOpen ? "Hide info panel" : "Show info panel"),
    visible: (ctx) => ctx.sessionOpen,
    run: (_ctx, h) => h.toggleInfo(),
  },
  // ── app ──
  {
    id: "sync",
    group: "app",
    label: () => "Sync now",
    visible: () => true,
    run: (_ctx, h) => h.sync(),
  },
  {
    id: "theme-toggle",
    group: "app",
    label: (ctx) => (ctx.theme === "light" ? "Switch to dark theme" : "Switch to light theme"),
    visible: () => true,
    run: (_ctx, h) => h.toggleTheme(),
  },
];

/** Visible actions for a ctx, fuzzy-filtered by the palette query (empty query = all
 *  visible, registry order). Non-empty query re-ranks by match score. */
export function filterActions(ctx: PaletteCtx, query: string): PaletteAction[] {
  const visible = PALETTE_ACTIONS.filter((a) => a.visible(ctx));
  const q = query.trim();
  if (!q) return visible;
  const scored: { a: PaletteAction; score: number }[] = [];
  for (const a of visible) {
    const score = fuzzyScore(q, a.label(ctx));
    if (score != null) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.map((x) => x.a);
}
