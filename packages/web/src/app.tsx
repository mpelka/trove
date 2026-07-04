import "./styles.css";
import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@cloudflare/kumo";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryState, parseAsString, parseAsBoolean, parseAsStringEnum } from "nuqs";
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
  // Search state lives in the URL (nuqs) so it's shareable / back-button friendly.
  const [query, setQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [agent, setAgent] = useQueryState("agent", parseAsString); // null = all agents
  const [starOnly, setStarOnly] = useQueryState("star", parseAsBoolean.withDefault(false));
  const [sort, setSort] = useQueryState(
    "sort",
    parseAsStringEnum(["relevance", "recent"]).withDefault("recent"),
  );
  const [view, setView] = useQueryState(
    "view",
    parseAsStringEnum(["sessions", "messages"]).withDefault("messages"),
  );
  const [selected, setSelected] = useState<Selected>(null);
  const dq = useDebounced(query, 160);

  return (
    <div className="app">
      <Header query={query} setQuery={(v) => setQuery(v || null)} />
      <div className="body">
        <Sidebar
          query={dq}
          agent={agent ?? undefined}
          setAgent={(a) => setAgent(a ?? null)}
          starOnly={starOnly}
          setStarOnly={(fn) => setStarOnly((p) => fn(p))}
          sort={sort}
          setSort={(s) => setSort(s)}
          view={view}
          setView={(v) => setView(v)}
          selected={selected}
          onSelect={setSelected}
        />
        <Detail
          key={selected?.id ?? "none"}
          id={selected?.id ?? null}
          targetMsgId={selected?.msgId ?? null}
          highlight={dq}
          onDeleted={() => setSelected(null)}
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
