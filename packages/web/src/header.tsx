import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Menu as MenuIcon, RefreshCw, Moon, Sun, X } from "lucide-react";
import { Popover, Button } from "@cloudflare/kumo";
import { trpc } from "./trpc.ts";
import { AgentBadge } from "./rows.tsx";

export function initialTheme(): "light" | "dark" {
  try {
    return (localStorage.getItem("trove-theme") as "light" | "dark") || "light";
  } catch {
    return "light";
  }
}

// ── settings flyout (Kumo Popover) ──────────────────────────────────────────
function SettingsMenu() {
  const qc = useQueryClient();
  const [theme, setTheme] = useState(initialTheme());
  const { data } = useQuery({ queryKey: ["status"], queryFn: () => trpc.status.query() });
  const sync = useMutation({ mutationFn: () => trpc.sync.mutate({}), onSuccess: () => qc.invalidateQueries() });
  const toggleTheme = () => {
    const n = theme === "light" ? "dark" : "light";
    setTheme(n);
    document.documentElement.dataset.mode = n;
    try {
      localStorage.setItem("trove-theme", n);
    } catch {}
  };
  return (
    <div className="menu">
      <Popover>
        <Popover.Trigger
          render={
            <button className="iconbtn" aria-label="menu">
              <MenuIcon size={16} />
            </button>
          }
        />
        <Popover.Content side="bottom" align="start" sideOffset={6} className="menu-panel">
          <div className="st">
            <span>sessions</span>
            <b>{data?.totalSessions ?? "—"}</b>
          </div>
          <div className="st">
            <span>messages</span>
            <b>{data?.totalMessages?.toLocaleString() ?? "—"}</b>
          </div>
          {data?.perAgent.map((a) => (
            <div className="st" key={a.agent}>
              <AgentBadge agent={a.agent} />
              <b>{a.sessions}</b>
            </div>
          ))}
          <hr />
          <div className="mrow">
            <Button
              variant="secondary"
              size="sm"
              disabled={sync.isPending}
              loading={sync.isPending}
              icon={<RefreshCw size={13} />}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? "syncing…" : "sync"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
              onClick={toggleTheme}
            >
              {theme === "light" ? "dark" : "light"}
            </Button>
          </div>
        </Popover.Content>
      </Popover>
    </div>
  );
}

export function Header({ query, setQuery }: { query: string; setQuery(v: string): void }) {
  return (
    <header className="header">
      <SettingsMenu />
      <div className="brand">
        trove<span className="dot">.</span>
      </div>
      <div className="header-search-wrap">
        <input
          className="header-search"
          autoFocus
          placeholder="Search every session…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
        {query && (
          <button className="search-clear" title="clear (Esc)" onClick={() => setQuery("")}>
            <X size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
