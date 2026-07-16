import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Menu as MenuIcon,
  RefreshCw,
  Moon,
  Sun,
  Search,
  Star,
  Highlighter,
  FoldHorizontal,
  RectangleHorizontal,
  UnfoldHorizontal,
  Rows2,
  Rows3,
  Rows4,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
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
// Theme state lives in App (the command palette toggles it too); the menu just
// renders the current value and calls up. Anchored to the rail, so it flies
// out to the RIGHT instead of dropping down.
function SettingsMenu({
  theme,
  onToggleTheme,
  hiddenAgents,
  onToggleAgentHidden,
}: {
  theme: "light" | "dark";
  onToggleTheme(): void;
  hiddenAgents: ReadonlySet<string>;
  onToggleAgentHidden(agent: string): void;
}) {
  const qc = useQueryClient();
  const [width, setWidth] = useState(() => readVar("trove-msg-width", WIDTH_DEFAULT));
  const [line, setLine] = useState(() => readVar("trove-msg-line", LINE_DEFAULT));
  const { data } = useQuery({ queryKey: ["status"], queryFn: () => trpc.status.query() });
  const sync = useMutation({ mutationFn: () => trpc.sync.mutate({}), onSuccess: () => qc.invalidateQueries() });
  return (
    <div className="menu">
      <Popover>
        <PopoverTrigger asChild>
          <button className="iconbtn" aria-label="menu" title="menu">
            <MenuIcon size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" sideOffset={10} className="menu-panel">
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
                {/* Chrome-only visibility switch: unchecked hides the sidebar filter
                    chip (and its palette action) on THIS machine — sessions stay in
                    "all", search, and jumps regardless. Persisted in localStorage. */}
                <Checkbox
                  checked={!hiddenAgents.has(a.agent)}
                  onCheckedChange={() => onToggleAgentHidden(a.agent)}
                  aria-label={`show ${agentLabel(a.agent)} filter chip`}
                  title="show filter chip (sessions stay searchable either way)"
                />
                <AgentBadge agent={a.agent} />
                <span className="agent-name">{agentLabel(a.agent)}</span>
                <b>{a.sessions.toLocaleString()}</b>
              </div>
            ))}
            <div className="sec-note">unchecked = hide filter chip; sessions stay in “all” &amp; search</div>
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

/** An icon button on the rail with a right-side tooltip. */
function RailButton({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className={className ?? "iconbtn"} aria-label={label} onClick={onClick}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// ── icon rail ────────────────────────────────────────────────────────────────
// A ~48px full-height strip on the far left — the top header's replacement, so
// the reader gets ALL the vertical space. Top-to-bottom: brand mark, settings
// menu, palette trigger, starred/highlights view toggles; theme toggle pinned
// to the bottom. The search trigger no longer displays the query text — while
// a search is active it carries an accent dot, names the query in its tooltip,
// and the palette offers a "Clear search" action, so search state stays one
// glance / one ⌘K away. Starred/highlights moved here from the sidebar's chip
// row (they're VIEW toggles, not agent filters) — they drive the same nuqs
// state the chips did; active = accent, same treatment as the raw-view button.
export function Rail({
  query,
  onOpenPalette,
  hint,
  theme,
  onToggleTheme,
  starOnly,
  onToggleStar,
  hlView,
  onToggleHl,
  hiddenAgents,
  onToggleAgentHidden,
}: {
  query: string;
  onOpenPalette(): void;
  hint: string; // platform-correct shortcut label (⌘K / Ctrl K)
  theme: "light" | "dark";
  onToggleTheme(): void;
  starOnly: boolean;
  onToggleStar(): void;
  hlView: boolean;
  onToggleHl(): void;
  hiddenAgents: ReadonlySet<string>;
  onToggleAgentHidden(agent: string): void;
}) {
  return (
    <nav className="rail" aria-label="app">
      <div className="rail-brand" title="trove" aria-hidden="true">
        t<span className="dot">.</span>
      </div>
      <SettingsMenu
        theme={theme}
        onToggleTheme={onToggleTheme}
        hiddenAgents={hiddenAgents}
        onToggleAgentHidden={onToggleAgentHidden}
      />
      <RailButton
        label={query ? `Searching “${query}” — ${hint}` : `Search (${hint})`}
        className="iconbtn rail-search"
        onClick={onOpenPalette}
      >
        <Search size={15} />
        {query && <span className="qdot" aria-hidden="true" />}
      </RailButton>
      <RailButton
        label={starOnly ? "starred only — on" : "starred only"}
        className={`iconbtn${starOnly ? " accent-on" : ""}`}
        onClick={onToggleStar}
      >
        <Star size={15} fill={starOnly ? "currentColor" : "none"} />
      </RailButton>
      <RailButton
        label={hlView ? "browse highlights — on" : "browse highlights"}
        className={`iconbtn${hlView ? " accent-on" : ""}`}
        onClick={onToggleHl}
      >
        <Highlighter size={15} />
      </RailButton>
      <div className="rail-spacer" />
      <RailButton
        label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        onClick={onToggleTheme}
      >
        {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
      </RailButton>
    </nav>
  );
}
