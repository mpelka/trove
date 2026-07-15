import "./styles.css";
import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryState, parseAsString, parseAsBoolean, parseAsInteger, parseAsStringEnum } from "nuqs";
import { Divider } from "./divider.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { queryClient, trpc } from "./trpc.ts";
import { Header, initialTheme } from "./header.tsx";
import { Sidebar, type Selected } from "./sidebar.tsx";
import { Detail } from "./detail.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { isMacLike, shortcutHint, type PaletteCtx, type PaletteHandlers } from "./palette-actions.ts";

// styles.css keys light/dark off `data-mode` on the root element (set pre-paint in index.html).
document.documentElement.dataset.mode = initialTheme();

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// restore the user's sidebar width before first paint
try {
  const saved = localStorage.getItem("trove-sidebar-w");
  if (saved) document.documentElement.style.setProperty("--sidebar-w", saved);
} catch {}

// restore the reader settings (conversation width + line-spacing) before first paint,
// same pattern as the sidebar width above — these drive --msg-width / --msg-line on .messages/.md
try {
  const w = localStorage.getItem("trove-msg-width");
  if (w) document.documentElement.style.setProperty("--msg-width", w);
  const l = localStorage.getItem("trove-msg-line");
  if (l) document.documentElement.style.setProperty("--msg-line", l);
} catch {}

// restore the info-panel width before first paint (same pattern) — drives --info-w
try {
  const iw = localStorage.getItem("trove-info-w");
  if (iw) document.documentElement.style.setProperty("--info-w", iw);
} catch {}

// Platform-correct palette shortcut: ⌘K on macOS, Ctrl+K elsewhere (WSL/Linux).
const MAC = isMacLike(navigator.platform || navigator.userAgent);

function App() {
  // ALL view state lives in the URL (nuqs): shareable, back-button friendly, and a
  // session link (?s=…&m=…) deep-links straight to a conversation/message.
  const [query, setQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [agent, setAgent] = useQueryState("agent", parseAsString); // null = all agents
  const [project, setProject] = useQueryState("project", parseAsString); // null = all projects
  const [starOnly, setStarOnly] = useQueryState("star", parseAsBoolean.withDefault(false));
  const [sort, setSort] = useQueryState(
    "sort",
    parseAsStringEnum(["relevance", "recent"]).withDefault("recent"),
  );
  const [view, setView] = useQueryState(
    "view",
    parseAsStringEnum(["sessions", "messages"]).withDefault("messages"),
  );
  const [bsort, setBsort] = useQueryState(
    "bsort",
    parseAsStringEnum(["updated", "created"]).withDefault("updated"),
  );
  const [order, setOrder] = useQueryState(
    "order",
    parseAsStringEnum(["desc", "asc"]).withDefault("desc"),
  );
  const [hlView, setHlView] = useQueryState("hl", parseAsBoolean.withDefault(false));
  const [infoOpen, setInfoOpen] = useQueryState("info", parseAsBoolean.withDefault(false));
  const [selId, setSelId] = useQueryState("s", parseAsString);
  const [selMsg, setSelMsg] = useQueryState("m", parseAsInteger);
  const dq = useDebounced(query, 160);

  // Reader-pane modes, lifted out of Detail so the command palette can drive them.
  // Still plain state (not URL): transient inspection modes shouldn't land in deep
  // links, and they reset when the selected session changes (see select()).
  const [expandAll, setExpandAll] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  // Theme lives here (not in the settings menu) so the menu and the palette stay in sync.
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme());
  const toggleTheme = () => {
    const n = theme === "light" ? "dark" : "light";
    setTheme(n);
    document.documentElement.dataset.mode = n;
    try {
      localStorage.setItem("trove-theme", n);
    } catch {}
  };

  const selected: Selected = selId ? { id: selId, msgId: selMsg ?? null } : null;
  const select = (sel: Selected) => {
    // Switching sessions drops the transient reader modes — same effect the old
    // Detail-local state got for free from its key={selId} remount.
    if ((sel?.id ?? null) !== selId) {
      setExpandAll(false);
      setRawOpen(false);
    }
    setSelId(sel?.id ?? null);
    setSelMsg(sel?.msgId ?? null);
  };

  // ── command palette (⌘K / Ctrl+K) ──────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const editable =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Don't hijack ⌘K while typing elsewhere (rename field etc.) — but the palette's
      // own input is exempt, so ⌘K toggles the palette closed again.
      if (editable && !t.closest("[cmdk-root]")) return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sync = useMutation({
    mutationFn: () => trpc.sync.mutate({}),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const searching = query.trim().length > 0 && !hlView;
  const paletteCtx: PaletteCtx = {
    agent: agent ?? null,
    starOnly,
    hlView,
    searching,
    bsort,
    order,
    sort,
    sessionOpen: !!selId,
    rawOpen,
    expandAll,
    infoOpen: infoOpen && !!selId,
    theme,
  };
  const paletteHandlers: PaletteHandlers = {
    setAgent: (a) => setAgent(a ?? null),
    toggleStarred: () => setStarOnly((p) => !p),
    toggleHighlights: () => setHlView(hlView ? null : true),
    setBsort: (v) => setBsort(v),
    setOrder: (v) => setOrder(v),
    setSort: (v) => setSort(v),
    sync: () => sync.mutate(),
    toggleTheme,
    toggleExpand: () => setExpandAll((v) => !v),
    toggleRaw: () => setRawOpen((v) => !v),
    toggleInfo: () => setInfoOpen(infoOpen ? null : true),
  };

  // The info panel only renders when a session is selected (Detail owns it), so only then
  // does the body need the 5-track grid template.
  const bodyInfoOpen = infoOpen && !!selId;

  return (
    <div className="app">
      <Header
        query={query}
        onClearQuery={() => setQuery(null)}
        onOpenPalette={() => setPaletteOpen(true)}
        hint={shortcutHint(MAC)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        ctx={paletteCtx}
        handlers={paletteHandlers}
        onJump={(id) => select({ id, msgId: null })}
        onSearch={(q) => setQuery(q || null)}
      />
      <div className={`body${bodyInfoOpen ? " info-open" : ""}`}>
        <Sidebar
          query={dq}
          agent={agent ?? undefined}
          setAgent={(a) => setAgent(a ?? null)}
          project={project}
          setProject={setProject}
          starOnly={starOnly}
          setStarOnly={(fn) => setStarOnly((p) => fn(p))}
          sort={sort}
          setSort={(s) => setSort(s)}
          view={view}
          setView={(v) => setView(v)}
          bsort={bsort}
          setBsort={(v) => setBsort(v)}
          order={order}
          setOrder={(v) => setOrder(v)}
          hlView={hlView}
          setHlView={(v) => setHlView(v || null)}
          selected={selected}
          onSelect={select}
        />
        <Divider />
        <Detail
          key={selId ?? "none"}
          id={selId}
          targetMsgId={selMsg}
          highlight={dq}
          expandAll={expandAll}
          onToggleExpand={() => setExpandAll((v) => !v)}
          rawOpen={rawOpen}
          onToggleRaw={() => setRawOpen((v) => !v)}
          infoOpen={infoOpen}
          onToggleInfo={() => setInfoOpen(infoOpen ? null : true)}
          onDeleted={() => select(null)}
          onProjectClick={(p) => setProject(p)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        {/* Groups tooltips so hovering between icon buttons skips the open delay. */}
        <TooltipProvider delayDuration={400}>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </NuqsAdapter>
  </StrictMode>,
);
