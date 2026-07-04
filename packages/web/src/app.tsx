import "./styles.css";
import { StrictMode, useState, useEffect, useMemo, memo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Star,
  Pencil,
  Copy,
  Check,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
  Menu as MenuIcon,
  RefreshCw,
  Moon,
  Sun,
  Asterisk,
  Sparkle,
  Bot,
  CornerDownRight,
  X,
} from "lucide-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useQueryState, parseAsString, parseAsBoolean, parseAsStringEnum } from "nuqs";
// Cloudflare Kumo (v2.6): styled, accessible components built on Base UI + Tailwind v4.
// Kumo's design tokens theme the app; the interactive bits use Kumo primitives.
import {
  Dialog,
  Popover,
  Tooltip,
  TooltipProvider,
  Tabs,
  Checkbox,
  Button,
  Badge,
} from "@cloudflare/kumo";
import type { AppRouter } from "@trove/api";

export const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] });
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 4000 } },
});

type Selected = { id: string; msgId: number | null } | null;

function initialTheme(): "light" | "dark" {
  try {
    return (localStorage.getItem("trove-theme") as "light" | "dark") || "light";
  } catch {
    return "light";
  }
}
// Kumo reads light/dark from `data-mode` on the root element (set pre-paint in index.html).
document.documentElement.dataset.mode = initialTheme();

// ── helpers ───────────────────────────────────────────────────────────────
function fmtRel(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = s / 86400;
  if (d < 30) return `${Math.floor(d)}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
function fmtSize(b: number | null | undefined): string {
  if (b == null) return "?";
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${Math.round(b / 1024)}K`;
  return `${(b / 1048576).toFixed(1)}M`;
}
const agentClass = (a: string) => (a === "claude-code" ? "cc" : a === "gemini-cli" ? "gemini" : "");
const agentLabel = (a: string) => (a === "claude-code" ? "CC" : a === "gemini-cli" ? "GEM" : a);
// Kumo Badge tint per agent (keeps the visual distinction from the hand-rolled version).
const agentBadgeVariant = (a: string) =>
  a === "claude-code" ? "orange" : a === "gemini-cli" ? "blue" : "neutral";
function projLabel(p: string | null): string {
  if (!p) return "no project";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function shortId(id: string): string {
  const i = id.indexOf(":");
  const agent = i < 0 ? "" : id.slice(0, i);
  const native = i < 0 ? id : id.slice(i + 1);
  const a = agent === "claude-code" ? "cc" : agent === "gemini-cli" ? "gem" : agent;
  const core = native.startsWith("session-") ? native.split("-").pop() || native : native;
  return `${a}·${core.slice(0, 8)}`;
}
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function rehypeHighlight(query: string) {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  return () => (tree: any) => {
    if (!terms.length) return;
    const re = new RegExp(`(${terms.join("|")})`, "i");
    const walk = (node: any) => {
      if (!node.children) return;
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === "text" && re.test(child.value)) {
          child.value.split(re).forEach((part: string, idx: number) => {
            if (part === "") return;
            if (idx % 2 === 1)
              out.push({ type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part }] });
            else out.push({ type: "text", value: part });
          });
        } else {
          if (child.type === "element") walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}
async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {}
}
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// Agent marker: a small round, tinted logo per agent. Generic glyphs (not the official
// trademarked logos): claude=asterisk-spark, gemini=sparkles, copilot=bot.
const AgentIcon = ({ agent }: { agent: string }) =>
  agent === "claude-code" ? <Asterisk size={15} strokeWidth={2.6} />
  : agent === "gemini-cli" ? <Sparkle size={13} strokeWidth={2.1} />
  : <Bot size={13} strokeWidth={2.1} />;

function AgentBadge({ agent }: { agent: string }) {
  return (
    <span className={`agentlogo ${agentClass(agent)}`} title={agent} aria-label={agentLabel(agent)}>
      <AgentIcon agent={agent} />
    </span>
  );
}

// Icon button with a Kumo Tooltip. `render` makes the trigger the button itself
// (no extra wrapper element that would break the flex layout).
function IconButton({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick?(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip
      content={label}
      side="bottom"
      render={
        <button className={className ?? "iconbtn"} aria-label={label} onClick={onClick}>
          {children}
        </button>
      }
    />
  );
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

function Header({ query, setQuery }: { query: string; setQuery(v: string): void }) {
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

// ── rows ──────────────────────────────────────────────────────────────────
function SessionRow(p: {
  name: string;
  agent: string;
  project: string | null;
  right: string;
  matchCount?: number;
  snippet?: string;
  starred: boolean;
  gone?: boolean;
  selected: boolean;
  onSelect(): void;
  onStar(): void;
}) {
  return (
    <div className={`row${p.selected ? " sel" : ""}`} onClick={p.onSelect}>
      <div className="top">
        <AgentBadge agent={p.agent} />
        <span className="name">{p.name || "(untitled)"}</span>
        {p.matchCount != null && <span className="count-pill">{p.matchCount}×</span>}
        <span
          className={`star${p.starred ? " on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onStar();
          }}
        >
          <Star size={14} fill={p.starred ? "currentColor" : "none"} />
        </span>
      </div>
      {p.snippet && (
        <div className="snippet">
          <Snippet text={p.snippet} />
        </div>
      )}
      <div className="sub">
        {p.gone && (
          <Badge variant="neutral" className="gonebadge">
            gone
          </Badge>
        )}
        <span className="proj" title={p.project ?? ""}>
          {projLabel(p.project)}
        </span>
        <span>· {p.right}</span>
      </div>
    </div>
  );
}

function MessageRow(p: {
  name: string;
  agent: string;
  role: string;
  snippet: string;
  ts: number | null;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <div className={`row${p.selected ? " sel" : ""}`} onClick={p.onSelect}>
      <div className="top">
        <AgentBadge agent={p.agent} />
        <span className="name">{p.name || "(untitled)"}</span>
        <span className="role">{p.role}</span>
      </div>
      <div className="snippet">
        <Snippet text={p.snippet} />
      </div>
      <div className="sub">
        <span>{fmtRel(p.ts)}</span>
      </div>
    </div>
  );
}

// ── sidebar ───────────────────────────────────────────────────────────────
function Sidebar(props: {
  query: string;
  agent: string | undefined;
  setAgent(a: string | undefined): void;
  starOnly: boolean;
  setStarOnly(v: (p: boolean) => boolean): void;
  sort: "relevance" | "recent";
  setSort(s: "relevance" | "recent"): void;
  view: "sessions" | "messages";
  setView(v: "sessions" | "messages"): void;
  selected: Selected;
  onSelect(s: Selected): void;
}) {
  const qc = useQueryClient();
  const { query, agent, setAgent, starOnly, setStarOnly, sort, setSort, view, setView, selected, onSelect } = props;
  const searching = query.trim().length > 0;

  const listQ = useQuery({
    queryKey: ["list", agent, starOnly],
    queryFn: () => trpc.list.query({ agent, star: starOnly, limit: 200, sort: "updated" }),
    enabled: !searching,
  });
  const searchQ = useQuery({
    queryKey: ["search", query, agent, starOnly, sort, view],
    queryFn: () =>
      trpc.search.query({
        query,
        agent,
        star: starOnly,
        limit: view === "messages" ? 80 : 50,
        sort,
        groupBySession: view === "sessions",
      }),
    enabled: searching,
  });
  // If the query looks like an id (short id, uuid, message #), offer a direct jump.
  const idHit = useQuery({
    queryKey: ["resolveId", query],
    queryFn: () => trpc.resolveId.query({ q: query }),
    enabled: searching,
  }).data;

  const star = useMutation({
    mutationFn: (v: { id: string; starred: boolean }) => trpc.setStar.mutate(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["list"] });
      qc.invalidateQueries({ queryKey: ["search"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const loading = searching ? searchQ.isLoading : listQ.isLoading;
  let body: ReactNode = null;
  let count = 0;

  if (searching && searchQ.data?.kind === "messages") {
    const hits = searchQ.data.hits;
    count = hits.length;
    body = hits.map((h) => (
      <MessageRow
        key={h.messageId}
        name={h.customName ?? h.title ?? ""}
        agent={h.agent}
        role={h.role}
        snippet={h.snippet}
        ts={h.timestamp}
        selected={selected?.id === h.sessionId && selected?.msgId === h.messageId}
        onSelect={() => onSelect({ id: h.sessionId, msgId: h.messageId })}
      />
    ));
  } else if (searching && searchQ.data?.kind === "sessions") {
    const hits = searchQ.data.hits;
    count = hits.length;
    body = hits.map((h) => (
      <SessionRow
        key={h.sessionId}
        name={h.customName ?? h.title ?? ""}
        agent={h.agent}
        project={h.projectPath}
        right={fmtRel(h.bestTimestamp)}
        matchCount={h.matchCount}
        snippet={h.bestSnippet}
        starred={h.starred}
        gone={h.sourceGone}
        selected={selected?.id === h.sessionId}
        onSelect={() => onSelect({ id: h.sessionId, msgId: null })}
        onStar={() => star.mutate({ id: h.sessionId, starred: !h.starred })}
      />
    ));
  } else if (!searching && listQ.data) {
    count = listQ.data.length;
    body = listQ.data.map((s) => (
      <SessionRow
        key={s.id}
        name={s.name}
        agent={s.agent}
        project={s.projectPath}
        right={`${s.turnCount ?? 0}t · ${fmtSize(s.sizeBytes)} · ${fmtRel(s.updatedAt)}`}
        starred={s.starred}
        gone={s.sourceGone}
        selected={selected?.id === s.id}
        onSelect={() => onSelect({ id: s.id, msgId: null })}
        onStar={() => star.mutate({ id: s.id, starred: !s.starred })}
      />
    ));
  }

  return (
    <div className="sidebar">
      <div className="sidebar-top">
        <div className="filters">
          <button className={`chip${!agent ? " on" : ""}`} onClick={() => setAgent(undefined)}>
            all
          </button>
          <button className={`chip${agent === "claude-code" ? " on" : ""}`} onClick={() => setAgent("claude-code")}>
            claude
          </button>
          <button className={`chip${agent === "gemini-cli" ? " on" : ""}`} onClick={() => setAgent("gemini-cli")}>
            gemini
          </button>
          <button className={`chip star${starOnly ? " on" : ""}`} onClick={() => setStarOnly((v) => !v)}>
            <Star size={12} fill={starOnly ? "currentColor" : "none"} /> starred
          </button>
          <span className="count">{loading ? "…" : count}</span>
        </div>
        {searching && (
          <div className="controls">
            <span className="lbl">sort</span>
            <Tabs
              variant="segmented"
              size="sm"
              className="seg"
              value={sort}
              onValueChange={(v) => setSort(v as "relevance" | "recent")}
              tabs={[
                { value: "relevance", label: "Best match" },
                { value: "recent", label: "Recent" },
              ]}
            />
            <span className="lbl">view</span>
            <Tabs
              variant="segmented"
              size="sm"
              className="seg"
              value={view}
              onValueChange={(v) => setView(v as "sessions" | "messages")}
              tabs={[
                { value: "sessions", label: "Conversations" },
                { value: "messages", label: "Messages" },
              ]}
            />
          </div>
        )}
      </div>
      <div className="list">
        {idHit && (
          <div
            className="row idrow"
            onClick={() => onSelect({ id: idHit.sessionId, msgId: idHit.messageId })}
          >
            <div className="top">
              <CornerDownRight size={14} />
              <span className="name">
                open {idHit.kind} · {shortId(idHit.sessionId)}
                {idHit.messageId != null ? ` · msg #${idHit.messageId}` : ""}
              </span>
            </div>
          </div>
        )}
        {loading && <div className="loading">searching…</div>}
        {!loading && count === 0 && !idHit && (
          <div className="loading">{searching ? "No matches." : "No sessions."}</div>
        )}
        {body}
      </div>
    </div>
  );
}

// ── messages (memoized so typing in the head doesn't re-render them) ─────────
const mdComponents = { a: (props: any) => <a {...props} target="_blank" rel="noopener noreferrer" /> };

const ChatMessage = memo(function ChatMessage(props: {
  id: number;
  role: string;
  text: string;
  ts: number | null;
  highlight: string;
  expandAll: boolean;
  resetTick: number;
}) {
  const { id, role, text, ts, highlight, expandAll, resetTick } = props;
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [resetTick]);
  const open = override ?? expandAll;
  const long = text.length > 1400;
  const rehype = highlight.trim() ? [rehypeHighlight(highlight)] : [];
  return (
    <div className={`msg ${role}`} id={`msg-${id}`}>
      <div className="who">
        <span className="dot" />
        {role === "user" ? "you" : "assistant"}
        <span className="t">{fmtRel(ts)}</span>
      </div>
      <div className={`clampwrap${long && !open ? " clamped" : ""}`}>
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype} components={mdComponents}>
            {text}
          </ReactMarkdown>
        </div>
      </div>
      {long && (
        <div className="more" onClick={() => setOverride(!open)}>
          {open ? "show less" : "show more"}
        </div>
      )}
    </div>
  );
});

function ToolGroup({ id, summary, ts }: { id: number; summary: string; ts: number | null }) {
  return (
    <div className="msg tool" id={`msg-${id}`}>
      <div className="who">
        <span className="dot" />
        tools<span className="t">{fmtRel(ts)}</span>
      </div>
      <div className="text">{summary}</div>
    </div>
  );
}

function parseUsed(text: string): string[] {
  const m = text.match(/^\[used:\s*(.+)\]$/);
  if (!m) return [text];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}
function summarizeTools(counts: Map<string, number>): string {
  return `[used: ${[...counts.entries()].map(([n, c]) => (c > 1 ? `${c}×${n}` : n)).join(", ")}]`;
}
type RenderItem =
  | { kind: "msg"; id: number; role: string; text: string; ts: number | null }
  | { kind: "tools"; id: number; counts: Map<string, number>; ts: number | null };
function buildItems(messages: { id: number; role: string; text: string; timestamp: number | null }[]): RenderItem[] {
  const items: RenderItem[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const names = parseUsed(m.text);
      const last = items[items.length - 1];
      if (last && last.kind === "tools") {
        for (const n of names) last.counts.set(n, (last.counts.get(n) ?? 0) + 1);
        last.ts = m.timestamp;
      } else {
        const counts = new Map<string, number>();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        items.push({ kind: "tools", id: m.id, counts, ts: m.timestamp });
      }
    } else {
      items.push({ kind: "msg", id: m.id, role: m.role, text: m.text, ts: m.timestamp });
    }
  }
  return items;
}

const MessageList = memo(function MessageList(props: {
  messages: { id: number; role: string; text: string; timestamp: number | null }[];
  highlight: string;
  expandAll: boolean;
  resetTick: number;
}) {
  const items = useMemo(() => buildItems(props.messages), [props.messages]);
  return (
    <div className="messages">
      {items.map((it) =>
        it.kind === "tools" ? (
          <ToolGroup key={it.id} id={it.id} summary={summarizeTools(it.counts)} ts={it.ts} />
        ) : (
          <ChatMessage
            key={it.id}
            id={it.id}
            role={it.role}
            text={it.text}
            ts={it.ts}
            highlight={props.highlight}
            expandAll={props.expandAll}
            resetTick={props.resetTick}
          />
        ),
      )}
    </div>
  );
});

// ── delete dialog (Kumo Dialog + Checkbox) ───────────────────────────────────
function ConfirmDelete({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(deleteSource: boolean): void;
}) {
  const [deleteSource, setDeleteSource] = useState(false);
  // Reset the checkbox each time the dialog opens.
  useEffect(() => {
    if (open) setDeleteSource(false);
  }, [open]);
  return (
    // role="alertdialog": destructive flow, not dismissible via outside click.
    <Dialog.Root role="alertdialog" open={open} onOpenChange={onOpenChange}>
      <Dialog size="sm" className="modal">
        <Dialog.Title className="modal-title">Delete conversation?</Dialog.Title>
        <Dialog.Description className="modal-desc">
          Remove <b>{name}</b> from trove. It won't come back on the next sync.
        </Dialog.Description>
        <Checkbox
          className="modal-check"
          checked={deleteSource}
          onCheckedChange={(v: boolean) => setDeleteSource(Boolean(v))}
          label={
            <>
              Also delete the original session file <span className="warn">(cannot be undone)</span>
            </>
          }
        />
        <div className="modal-actions">
          <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
          <Button variant="destructive" icon={<Trash2 size={13} />} onClick={() => onConfirm(deleteSource)}>
            Delete
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

// ── detail head (owns the typing-heavy state, isolated from MessageList) ─────
function DetailHead({
  session,
  resumeCommand,
  expandAll,
  onToggleExpand,
  onDeleted,
}: {
  session: any;
  resumeCommand: string | null;
  expandAll: boolean;
  onToggleExpand(): void;
  onDeleted(): void;
}) {
  const qc = useQueryClient();
  const s = session;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["detail", s.id] });
    qc.invalidateQueries({ queryKey: ["list"] });
    qc.invalidateQueries({ queryKey: ["search"] });
  };
  const mName = useMutation({
    mutationFn: (name: string | null) => trpc.setName.mutate({ id: s.id, name }),
    onSuccess: invalidate,
  });
  const mStar = useMutation({
    mutationFn: (starred: boolean) => trpc.setStar.mutate({ id: s.id, starred }),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const mDelete = useMutation({
    mutationFn: (deleteSource: boolean) => trpc.deleteSession.mutate({ id: s.id, deleteSource }),
    onSuccess: () => {
      qc.invalidateQueries();
      onDeleted();
    },
  });

  const copy = async (text: string, label: string) => {
    await copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  const startEdit = () => {
    setDraft(s.customName ?? s.name);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v === "") {
      if (s.customName != null) mName.mutate(null);
    } else if (v !== s.name) mName.mutate(v);
  };

  return (
    <div className="detail-head">
      <div className="dh-title">
        <AgentBadge agent={s.agent} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <>
            <span className="title" title="double-click to rename" onDoubleClick={startEdit}>
              {s.name}
            </span>
            {s.customName && <Pencil size={12} className="custom-mark" aria-label="custom name" />}
            {s.sourceGone && (
              <Badge variant="neutral" className="gonebadge">
                gone
              </Badge>
            )}
          </>
        )}
        <div className="dh-actions">
          <IconButton
            label="star"
            className={`iconbtn${s.starred ? " on" : ""}`}
            onClick={() => mStar.mutate(!s.starred)}
          >
            <Star size={15} fill={s.starred ? "currentColor" : "none"} />
          </IconButton>
          <IconButton label="rename" onClick={startEdit}>
            <Pencil size={14} />
          </IconButton>
          {resumeCommand && (
            <IconButton label="copy resume command" onClick={() => copy(resumeCommand, "resume")}>
              {copied === "resume" ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
          <IconButton label={expandAll ? "collapse all" : "expand all"} onClick={onToggleExpand}>
            {expandAll ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
          </IconButton>
          <IconButton label="delete" className="iconbtn danger" onClick={() => setConfirming(true)}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
      <div className="dh-meta">
        <span title={s.projectPath ?? ""}>
          <span className="k">project</span> {projLabel(s.projectPath)}
        </span>
        <span>
          <span className="k">turns</span> {s.turnCount ?? 0}
        </span>
        <span>
          <span className="k">msgs</span> {s.messageCount ?? 0}
        </span>
        <span>
          <span className="k">model</span> {s.model ?? "?"}
        </span>
        <span>
          <span className="k">updated</span> {fmtRel(s.updatedAt)}
        </span>
        <span className="sid" title={`${s.id} — click to copy`} onClick={() => copy(s.id, "id")}>
          {shortId(s.id)}
          {copied === "id" ? " ✓" : ""}
        </span>
      </div>
      <ConfirmDelete
        name={s.name}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={(deleteSource) => {
          setConfirming(false);
          mDelete.mutate(deleteSource);
        }}
      />
    </div>
  );
}

// ── detail ────────────────────────────────────────────────────────────────
function Detail({
  id,
  targetMsgId,
  highlight,
  onDeleted,
}: {
  id: string | null;
  targetMsgId: number | null;
  highlight: string;
  onDeleted(): void;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const [resetTick, setResetTick] = useState(0);
  const { data, isLoading } = useQuery({
    queryKey: ["detail", id],
    queryFn: () => trpc.sessionDetail.query({ id: id! }),
    enabled: !!id,
  });

  useEffect(() => {
    if (!data || targetMsgId == null) return;
    const el = document.getElementById(`msg-${targetMsgId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("jump");
    const t = setTimeout(() => el.classList.remove("jump"), 1800);
    return () => clearTimeout(t);
  }, [data, targetMsgId]);

  if (!id) return <div className="detail-empty">Select a session to read it.</div>;
  if (isLoading || !data)
    return (
      <div className="detail">
        <div className="loading">loading…</div>
      </div>
    );

  return (
    <div className="detail">
      <DetailHead
        session={data.session}
        resumeCommand={data.resumeCommand}
        expandAll={expandAll}
        onToggleExpand={() => {
          setExpandAll((v) => !v);
          setResetTick((t) => t + 1);
        }}
        onDeleted={onDeleted}
      />
      <MessageList messages={data.messages} highlight={highlight} expandAll={expandAll} resetTick={resetTick} />
    </div>
  );
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
