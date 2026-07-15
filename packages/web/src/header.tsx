import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Menu as MenuIcon,
  RefreshCw,
  Moon,
  Sun,
  X,
  Search,
  FoldHorizontal,
  RectangleHorizontal,
  UnfoldHorizontal,
  Rows2,
  Rows3,
  Rows4,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover.tsx";
import { Button } from "./ui/button.tsx";
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

// ── settings flyout ─────────────────────────────────────────────────────────
// Theme state lives in App now (the command palette toggles it too); the menu just
// renders the current value and calls up.
function SettingsMenu({ theme, onToggleTheme }: { theme: "light" | "dark"; onToggleTheme(): void }) {
  const qc = useQueryClient();
  const [width, setWidth] = useState(() => readVar("trove-msg-width", WIDTH_DEFAULT));
  const [line, setLine] = useState(() => readVar("trove-msg-line", LINE_DEFAULT));
  const { data } = useQuery({ queryKey: ["status"], queryFn: () => trpc.status.query() });
  const sync = useMutation({ mutationFn: () => trpc.sync.mutate({}), onSuccess: () => qc.invalidateQueries() });
  return (
    <div className="menu">
      <Popover>
        <PopoverTrigger asChild>
          <button className="iconbtn" aria-label="menu">
            <MenuIcon size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" sideOffset={6} className="menu-panel">
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
              // The icon spins in place while syncing — same idiom the detail pane's
              // re-summarize / summarize actions already use.
              icon={<RefreshCw size={13} className={sync.isPending ? "spin" : ""} />}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? "syncing…" : "sync"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
              onClick={onToggleTheme}
            >
              {theme === "light" ? "dark" : "light"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── slim header ──────────────────────────────────────────────────────────────
// One ~44px row: menu, wordmark, and a compact palette trigger. The old always-
// focused search input is gone — the ⌘K palette writes the same ?q state, and the
// trigger doubles as the visible home of the active query (with a clear button),
// so search state never becomes invisible.
export function Header({
  query,
  onClearQuery,
  onOpenPalette,
  hint,
  theme,
  onToggleTheme,
}: {
  query: string;
  onClearQuery(): void;
  onOpenPalette(): void;
  hint: string; // platform-correct shortcut label (⌘K / Ctrl K)
  theme: "light" | "dark";
  onToggleTheme(): void;
}) {
  return (
    <header className="header">
      <SettingsMenu theme={theme} onToggleTheme={onToggleTheme} />
      <div className="brand">
        trove<span className="dot">.</span>
      </div>
      <button className="palette-btn" title={`Search (${hint})`} onClick={onOpenPalette}>
        <Search size={13} />
        <span className={`palette-q${query ? " active" : ""}`}>{query || "Search…"}</span>
        <kbd>{hint}</kbd>
      </button>
      {query && (
        <button className="iconbtn palette-clear" aria-label="clear search" title="clear search" onClick={onClearQuery}>
          <X size={14} />
        </button>
      )}
    </header>
  );
}
