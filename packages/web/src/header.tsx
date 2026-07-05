import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Menu as MenuIcon,
  RefreshCw,
  Moon,
  Sun,
  X,
  FoldHorizontal,
  RectangleHorizontal,
  UnfoldHorizontal,
  Rows2,
  Rows3,
  Rows4,
} from "lucide-react";
import { Popover, Button } from "@cloudflare/kumo";
import { trpc } from "./trpc.ts";
import { AgentBadge } from "./rows.tsx";
import { agentLabel } from "./lib.ts";

export function initialTheme(): "light" | "dark" {
  try {
    return (localStorage.getItem("trove-theme") as "light" | "dark") || "light";
  } catch {
    return "light";
  }
}

// ── reader settings: conversation width + line spacing ──────────────────────
// Each preset drives a CSS var on <html> consumed by .messages / .md, and is
// persisted to localStorage + restored pre-paint (see app.tsx), mirroring the
// divider-width pattern.
type Preset = { key: string; value: string; Icon: typeof Rows2; label: string };

const WIDTH_PRESETS: Preset[] = [
  { key: "narrow", value: "60ch", Icon: FoldHorizontal, label: "narrow" },
  { key: "medium", value: "80ch", Icon: RectangleHorizontal, label: "medium" },
  { key: "wide", value: "100ch", Icon: UnfoldHorizontal, label: "wide" },
];
const LINE_PRESETS: Preset[] = [
  { key: "tight", value: "1.4", Icon: Rows2, label: "tight" },
  { key: "normal", value: "1.6", Icon: Rows3, label: "normal" },
  { key: "relaxed", value: "1.9", Icon: Rows4, label: "relaxed" },
];

const WIDTH_DEFAULT = "80ch"; // medium
const LINE_DEFAULT = "1.6"; // normal

function readVar(storageKey: string, fallback: string): string {
  try {
    return localStorage.getItem(storageKey) || fallback;
  } catch {
    return fallback;
  }
}

/** A labelled row of 3 icon-buttons; the active preset is visually marked. */
function PresetRow({
  label,
  presets,
  cssVar,
  storageKey,
  value,
  onPick,
}: {
  label: string;
  presets: Preset[];
  cssVar: string;
  storageKey: string;
  value: string;
  onPick(v: string): void;
}) {
  const set = (v: string) => {
    document.documentElement.style.setProperty(cssVar, v);
    try {
      localStorage.setItem(storageKey, v);
    } catch {}
    onPick(v);
  };
  return (
    <div className="reader-row">
      <span>{label}</span>
      <div className="segbtns" role="group" aria-label={label}>
        {presets.map((p) => (
          <button
            key={p.key}
            className={`segbtn${value === p.value ? " on" : ""}`}
            aria-label={p.label}
            aria-pressed={value === p.value}
            title={p.label}
            onClick={() => set(p.value)}
          >
            <p.Icon size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── settings flyout (Kumo Popover) ──────────────────────────────────────────
function SettingsMenu() {
  const qc = useQueryClient();
  const [theme, setTheme] = useState(initialTheme());
  const [width, setWidth] = useState(() => readVar("trove-msg-width", WIDTH_DEFAULT));
  const [line, setLine] = useState(() => readVar("trove-msg-line", LINE_DEFAULT));
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
          <hr />
          <div className="sec">
            <div className="sec-label">agents</div>
            {data?.perAgent.map((a) => (
              <div className="st agent-st" key={a.agent}>
                <AgentBadge agent={a.agent} />
                <span className="agent-name">{agentLabel(a.agent)}</span>
                <b>{a.sessions.toLocaleString()}</b>
              </div>
            ))}
          </div>
          <hr />
          <div className="sec">
            <div className="sec-label">reader</div>
            <PresetRow
              label="width"
              presets={WIDTH_PRESETS}
              cssVar="--msg-width"
              storageKey="trove-msg-width"
              value={width}
              onPick={setWidth}
            />
            <PresetRow
              label="spacing"
              presets={LINE_PRESETS}
              cssVar="--msg-line"
              storageKey="trove-msg-line"
              value={line}
              onPick={setLine}
            />
          </div>
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
