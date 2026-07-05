import "./styles.css";
import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@cloudflare/kumo";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryState, parseAsString, parseAsBoolean, parseAsInteger, parseAsStringEnum } from "nuqs";
// Cloudflare Kumo (v2.6): styled, accessible components built on Base UI + Tailwind v4.
// Kumo's design tokens theme the app; the interactive bits use Kumo primitives.
import { queryClient } from "./trpc.ts";
import { Header, initialTheme } from "./header.tsx";
import { Sidebar, type Selected } from "./sidebar.tsx";
import { Detail } from "./detail.tsx";

// Kumo reads light/dark from `data-mode` on the root element (set pre-paint in index.html).
document.documentElement.dataset.mode = initialTheme();

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

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
  const [selId, setSelId] = useQueryState("s", parseAsString);
  const [selMsg, setSelMsg] = useQueryState("m", parseAsInteger);
  const dq = useDebounced(query, 160);

  const selected: Selected = selId ? { id: selId, msgId: selMsg ?? null } : null;
  const select = (sel: Selected) => {
    setSelId(sel?.id ?? null);
    setSelMsg(sel?.msgId ?? null);
  };

  return (
    <div className="app">
      <Header query={query} setQuery={(v) => setQuery(v || null)} />
      <div className="body">
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
          selected={selected}
          onSelect={select}
        />
        <Detail
          key={selId ?? "none"}
          id={selId}
          targetMsgId={selMsg}
          highlight={dq}
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
        {/* Kumo TooltipProvider groups tooltips so hovering between icon buttons skips the open delay. */}
        <TooltipProvider delay={400}>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </NuqsAdapter>
  </StrictMode>,
);
