import { describe, it, expect } from "bun:test";
import {
  isMacLike,
  shortcutHint,
  fuzzyScore,
  fuzzyFilterSessions,
  filterActions,
  PALETTE_ACTIONS,
  AGENTS,
  type PaletteCtx,
  type PaletteHandlers,
} from "./palette-actions.ts";

// A neutral baseline ctx; tests override the fields they care about.
const ctx = (over: Partial<PaletteCtx> = {}): PaletteCtx => ({
  agent: null,
  visibleAgents: AGENTS.map((a) => a.id), // baseline: every chip visible
  starOnly: false,
  hlView: false,
  searching: false,
  bsort: "updated",
  order: "desc",
  sort: "recent",
  sessionOpen: false,
  rawOpen: false,
  expandAll: false,
  infoOpen: false,
  theme: "light",
  ...over,
});

const action = (id: string) => {
  const a = PALETTE_ACTIONS.find((a) => a.id === id);
  if (!a) throw new Error(`no action ${id}`);
  return a;
};

// Handler spy: records which handler ran (and with what).
const spy = () => {
  const calls: [string, ...unknown[]][] = [];
  const h = new Proxy({} as PaletteHandlers, {
    get:
      (_t, name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]),
  });
  return { h, calls };
};

describe("isMacLike / shortcutHint", () => {
  it("detects mac-ish platforms, not linux/windows", () => {
    expect(isMacLike("MacIntel")).toBe(true);
    expect(isMacLike("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(true);
    expect(isMacLike("Linux x86_64")).toBe(false);
    expect(isMacLike("Win32")).toBe(false);
    expect(isMacLike("")).toBe(false);
  });
  it("maps platform to the hint label", () => {
    expect(shortcutHint(true)).toBe("⌘K");
    expect(shortcutHint(false)).toBe("Ctrl K");
  });
});

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively, rejects non-subsequences", () => {
    expect(fuzzyScore("rw", "raw view")).not.toBeNull();
    expect(fuzzyScore("RAW", "open raw source")).not.toBeNull();
    expect(fuzzyScore("xyz", "raw view")).toBeNull();
    expect(fuzzyScore("views", "raw view")).toBeNull(); // exhausts text
  });
  it("empty query matches everything with a zero score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("prefers contiguous and word-boundary matches", () => {
    // "fix" contiguous at a word start vs scattered f…i…x
    const tight = fuzzyScore("fix", "fix the header")!;
    const scattered = fuzzyScore("fix", "ify pixel")!;
    expect(tight).toBeGreaterThan(scattered);
    // word-start match beats mid-word match
    const boundary = fuzzyScore("view", "raw view")!;
    const midword = fuzzyScore("view", "preview")!;
    expect(boundary).toBeGreaterThan(midword);
  });
});

describe("fuzzyFilterSessions", () => {
  const S = (id: string, name: string) => ({ id, name });
  const sessions = [
    S("1", "gemini storage diagnostics"),
    S("2", "search semantics rework"),
    S("3", "raw source view"),
    S("4", "sidebar polish"),
  ];
  it("returns nothing for an empty/whitespace query", () => {
    expect(fuzzyFilterSessions(sessions, "")).toEqual([]);
    expect(fuzzyFilterSessions(sessions, "   ")).toEqual([]);
  });
  it("filters to fuzzy matches, best first", () => {
    const hits = fuzzyFilterSessions(sessions, "raw");
    expect(hits[0]!.id).toBe("3");
    expect(hits.every((s) => fuzzyScore("raw", s.name) != null)).toBe(true);
  });
  it("breaks score ties toward shorter names and respects the limit", () => {
    const many = [S("a", "sync one"), S("b", "sync one longer"), S("c", "sync"), S("d", "sync two")];
    const hits = fuzzyFilterSessions(many, "sync", 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.id).toBe("c"); // same score, shortest name wins
  });
});

describe("action visibility predicates", () => {
  it("session actions require an open session; expand also requires the reader (not raw)", () => {
    const closed = ctx();
    for (const id of ["expand-toggle", "raw-toggle", "info-toggle"]) {
      expect(action(id).visible(closed)).toBe(false);
    }
    const open = ctx({ sessionOpen: true });
    for (const id of ["expand-toggle", "raw-toggle", "info-toggle"]) {
      expect(action(id).visible(open)).toBe(true);
    }
    expect(action("expand-toggle").visible(ctx({ sessionOpen: true, rawOpen: true }))).toBe(false);
    expect(action("raw-toggle").visible(ctx({ sessionOpen: true, rawOpen: true }))).toBe(true);
  });

  it("browse-sort actions hide while searching; search-sort actions only show then", () => {
    const browse = ctx();
    expect(action("order-toggle").visible(browse)).toBe(true);
    expect(action("sort-created").visible(browse)).toBe(true); // bsort=updated → offer created
    expect(action("sort-updated").visible(browse)).toBe(false);
    expect(action("search-sort-relevance").visible(browse)).toBe(false);

    const searching = ctx({ searching: true });
    expect(action("order-toggle").visible(searching)).toBe(false);
    expect(action("sort-created").visible(searching)).toBe(false);
    expect(action("search-sort-relevance").visible(searching)).toBe(true); // sort=recent → offer best match
    expect(action("search-sort-recent").visible(searching)).toBe(false);
    expect(action("search-sort-recent").visible(ctx({ searching: true, sort: "relevance" }))).toBe(true);
  });

  it("agent filters hide the already-active agent; 'all' only shows when filtered", () => {
    expect(action("filter-agent-all").visible(ctx())).toBe(false);
    expect(action("filter-agent-all").visible(ctx({ agent: "claude-code" }))).toBe(true);
    expect(action("filter-agent-claude-code").visible(ctx({ agent: "claude-code" }))).toBe(false);
    expect(action("filter-agent-gemini-cli").visible(ctx({ agent: "claude-code" }))).toBe(true);
    // one filter action per agent exists
    for (const a of AGENTS) expect(() => action(`filter-agent-${a.id}`)).not.toThrow();
  });

  it("agent filter actions mirror chip visibility (hidden chip → no action)", () => {
    const some = ctx({ visibleAgents: ["claude-code", "gemini-cli"] });
    expect(action("filter-agent-claude-code").visible(some)).toBe(true);
    expect(action("filter-agent-gemini-cli").visible(some)).toBe(true);
    for (const id of ["copilot", "antigravity", "chatgpt", "claude-web"]) {
      expect(action(`filter-agent-${id}`).visible(some)).toBe(false);
    }
    // fresh/empty store: no chips → no per-agent actions at all
    const none = ctx({ visibleAgents: [] });
    for (const a of AGENTS) expect(action(`filter-agent-${a.id}`).visible(none)).toBe(false);
    // …but "Show all agents" ignores visibility — it clears, never narrows
    expect(action("filter-agent-all").visible(ctx({ agent: "copilot", visibleAgents: [] }))).toBe(true);
    // active agent stays hidden as an action even when its chip is visible (it's already applied)
    expect(
      action("filter-agent-gemini-cli").visible(ctx({ agent: "gemini-cli", visibleAgents: ["gemini-cli"] })),
    ).toBe(false);
  });

  it("clear-search only shows while a search is active", () => {
    expect(action("clear-search").visible(ctx())).toBe(false);
    expect(action("clear-search").visible(ctx({ searching: true }))).toBe(true);
    expect(action("clear-search").visible(ctx({ searching: true, sessionOpen: true }))).toBe(true);
  });

  it("always-on actions: sync, theme, starred, highlights", () => {
    for (const id of ["sync", "theme-toggle", "toggle-starred", "toggle-highlights"]) {
      expect(action(id).visible(ctx())).toBe(true);
      expect(action(id).visible(ctx({ searching: true, sessionOpen: true, rawOpen: true }))).toBe(true);
    }
  });
});

describe("action labels reflect state", () => {
  it("toggles word their target state", () => {
    expect(action("theme-toggle").label(ctx())).toBe("Switch to dark theme");
    expect(action("theme-toggle").label(ctx({ theme: "dark" }))).toBe("Switch to light theme");
    expect(action("toggle-starred").label(ctx())).toBe("Show starred only");
    expect(action("toggle-starred").label(ctx({ starOnly: true }))).toBe("Starred only: off");
    expect(action("expand-toggle").label(ctx({ sessionOpen: true }))).toBe("Expand all messages");
    expect(action("expand-toggle").label(ctx({ sessionOpen: true, expandAll: true }))).toBe(
      "Collapse all messages",
    );
    expect(action("raw-toggle").label(ctx({ sessionOpen: true }))).toBe("Open raw source");
    expect(action("raw-toggle").label(ctx({ sessionOpen: true, rawOpen: true }))).toBe("Back to conversation");
    expect(action("order-toggle").label(ctx())).toBe("Order: oldest first");
    expect(action("order-toggle").label(ctx({ order: "asc" }))).toBe("Order: newest first");
  });
});

describe("action run() dispatch", () => {
  it("routes each action to the right handler", () => {
    const cases: [string, PaletteCtx, string, ...unknown[]][] = [
      ["filter-agent-all", ctx({ agent: "chatgpt" }), "setAgent", undefined],
      ["filter-agent-gemini-cli", ctx(), "setAgent", "gemini-cli"],
      ["toggle-starred", ctx(), "toggleStarred"],
      ["toggle-highlights", ctx(), "toggleHighlights"],
      ["sort-created", ctx(), "setBsort", "created"],
      ["sort-updated", ctx({ bsort: "created" }), "setBsort", "updated"],
      ["order-toggle", ctx(), "setOrder", "asc"],
      ["order-toggle", ctx({ order: "asc" }), "setOrder", "desc"],
      ["search-sort-relevance", ctx({ searching: true }), "setSort", "relevance"],
      ["search-sort-recent", ctx({ searching: true, sort: "relevance" }), "setSort", "recent"],
      ["clear-search", ctx({ searching: true }), "clearSearch"],
      ["sync", ctx(), "sync"],
      ["theme-toggle", ctx(), "toggleTheme"],
      ["expand-toggle", ctx({ sessionOpen: true }), "toggleExpand"],
      ["raw-toggle", ctx({ sessionOpen: true }), "toggleRaw"],
      ["info-toggle", ctx({ sessionOpen: true }), "toggleInfo"],
    ];
    for (const [id, c, ...expected] of cases) {
      const { h, calls } = spy();
      action(id).run(c, h);
      expect(calls).toEqual([expected as [string, ...unknown[]]]);
    }
  });
});

describe("filterActions", () => {
  it("empty query returns all visible actions in registry order", () => {
    const c = ctx({ sessionOpen: true });
    const ids = filterActions(c, "").map((a) => a.id);
    expect(ids).toEqual(PALETTE_ACTIONS.filter((a) => a.visible(c)).map((a) => a.id));
    expect(ids).toContain("expand-toggle");
    expect(ids).not.toContain("filter-agent-all"); // no agent filter active
  });
  it("query fuzzy-filters against the current label", () => {
    const c = ctx({ sessionOpen: true });
    const ids = filterActions(c, "raw").map((a) => a.id);
    expect(ids).toContain("raw-toggle");
    expect(ids).not.toContain("sync");
    // label is state-dependent: "collapse" only matches when expandAll is on
    expect(filterActions(c, "collapse").map((a) => a.id)).not.toContain("expand-toggle");
    expect(filterActions(ctx({ sessionOpen: true, expandAll: true }), "collapse").map((a) => a.id)).toContain(
      "expand-toggle",
    );
  });
  it("hidden actions never surface, however well they match", () => {
    expect(filterActions(ctx(), "raw source").map((a) => a.id)).not.toContain("raw-toggle");
  });
});
