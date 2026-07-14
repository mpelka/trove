import "./styles.css";
import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryState, parseAsString, parseAsBoolean, parseAsInteger, parseAsStringEnum } from "nuqs";
import { Divider } from "./divider.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { queryClient } from "./trpc.ts";
import { Header, initialTheme } from "./header.tsx";
import { Sidebar, type Selected } from "./sidebar.tsx";
import { Detail } from "./detail.tsx";

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

  const selected: Selected = selId ? { id: selId, msgId: selMsg ?? null } : null;
  const select = (sel: Selected) => {
    setSelId(sel?.id ?? null);
    setSelMsg(sel?.msgId ?? null);
  };

  // The info panel only renders when a session is selected (Detail owns it), so only then
  // does the body need the 5-track grid template.
  const bodyInfoOpen = infoOpen && !!selId;

  return (
    <div className="app">
      <Header query={query} setQuery={(v) => setQuery(v || null)} />
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
