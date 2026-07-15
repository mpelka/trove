import { useState, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Pencil,
  Copy,
  Check,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
  Highlighter,
  Sparkles,
  RefreshCw,
  X,
  ChevronRight,
  ChevronDown,
  PanelRight,
  PanelRightOpen,
  AlertTriangle,
  FileCode,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "./ui/dialog.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { trpc } from "./trpc.ts";
import { fmtRel, fmtSize, projLabel, shortId } from "./lib.ts";
import { AgentBadge } from "./rows.tsx";
import { MessageList } from "./messages.tsx";
import { RawView } from "./raw-view.tsx";
import { Divider } from "./divider.tsx";

const mdComponents = { a: (props: any) => <a {...props} target="_blank" rel="noopener noreferrer" /> };

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {}
}

// Icon button with a tooltip. `asChild` makes the trigger the button itself, so no
// wrapper element lands in the surrounding flex row.
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button className={className ?? "iconbtn"} aria-label={label} onClick={onClick}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

// ── delete dialog ────────────────────────────────────────────────────────────
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* alert: destructive flow, so role="alertdialog" and no outside-click dismissal. */}
      <DialogContent alert>
        <DialogTitle className="modal-title">Delete conversation?</DialogTitle>
        <DialogDescription className="modal-desc">
          Remove <b>{name}</b> from trove. It won't come back on the next sync.
        </DialogDescription>
        <Checkbox
          className="modal-check"
          checked={deleteSource}
          onCheckedChange={(v) => setDeleteSource(v === true)}
          label={
            <>
              Also delete the original session file <span className="warn">(cannot be undone)</span>
            </>
          }
        />
        <div className="modal-actions">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" icon={<Trash2 size={13} />} onClick={() => onConfirm(deleteSource)}>
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── generic confirm dialog — used for highlight removal from both the inline ────
//    mark click and the info-panel ✕, so the two paths behave identically.
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix points aria-describedby at the Description's id by default; drop it when
          there's no body, so it can't dangle at an element that was never rendered. */}
      <DialogContent alert {...(body ? {} : { "aria-describedby": undefined })}>
        <DialogTitle className="modal-title">{title}</DialogTitle>
        {body && <DialogDescription className="modal-desc">{body}</DialogDescription>}
        <div className="modal-actions">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" icon={<Trash2 size={13} />} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── ghostwriter error (friendly headline + collapsible raw detail) ────────────
function SummaryError({ error, onDismiss }: { error: string; onDismiss(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ghost-error">
      <div className="ghost-error-head">
        <AlertTriangle size={13} className="ghost-error-icon" />
        <span className="ghost-error-title">Couldn’t generate the summary</span>
        <button className="ghost-error-x" aria-label="dismiss" onClick={onDismiss}>
          <X size={12} />
        </button>
      </div>
      <p className="ghost-error-hint">The summarizer command failed — check its auth or the command in your trove config.</p>
      <button className="ghost-error-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} details
      </button>
      {open && <pre className="ghost-error-detail">{error}</pre>}
    </div>
  );
}

// ── ghostwriter summary card (issue #17) ─────────────────────────────────────
function SummaryCard({
  summary,
  onRefresh,
  onRemove,
  refreshing,
}: {
  summary: { text: string; createdAt: number };
  onRefresh(): void;
  onRemove(): void;
  refreshing: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="ghost-card">
      <div className="ghost-head">
        <button
          className="ghost-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "expand summary" : "collapse summary"}
        >
          <ChevronRight size={13} className={collapsed ? "" : "open"} />
          <Sparkles size={13} />
          <span className="ghost-label">ghostwriter summary</span>
        </button>
        <span className="ghost-time">{fmtRel(summary.createdAt)}</span>
        <span className="ghost-actions">
          <IconButton label="re-summarize" className="ghost-btn" onClick={onRefresh}>
            <RefreshCw size={13} className={refreshing ? "spin" : ""} />
          </IconButton>
          <IconButton label="remove summary" className="ghost-btn" onClick={onRemove}>
            <X size={13} />
          </IconButton>
        </span>
      </div>
      {!collapsed && (
        <div className="ghost-body md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {summary.text}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ── metadata panel (issue #22): the session's sidecar data lives here ────────
function InfoPanel({
  session,
  summary,
  summaryError,
  onDismissError,
  summarizing,
  onSummarize,
  onRemoveSummary,
  summarizerAvailable,
  highlights,
  onJumpHighlight,
  onRemoveHighlight,
  onProjectClick,
}: {
  session: any;
  summary: { text: string; createdAt: number } | null;
  summaryError: string | null;
  onDismissError(): void;
  summarizing: boolean;
  onSummarize(force: boolean): void;
  onRemoveSummary(): void;
  summarizerAvailable: boolean;
  highlights: { id: number; messageUid: string | null; messageSeq: number | null; text: string; note: string | null; createdAt: number }[];
  onJumpHighlight(h: { messageUid: string | null; messageSeq: number | null }): void;
  onRemoveHighlight(id: number): void;
  onProjectClick(project: string): void;
}) {
  const s = session;
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    await copyText(`${location.origin}${location.pathname}?s=${encodeURIComponent(s.id)}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const abs = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "");

  return (
    <aside className="info-panel">
      <div className="info-body">
        <section className="info-sec">
          <h3 className="info-h">Metadata</h3>
          <dl className="info-meta">
            <dt>project</dt>
            <dd title={s.projectPath ? `${s.projectPath} — click to filter the list` : ""}>
              {s.projectPath ? (
                <button className="linklike" onClick={() => onProjectClick(s.projectPath)}>
                  {projLabel(s.projectPath)}
                </button>
              ) : (
                projLabel(s.projectPath)
              )}
            </dd>
            <dt>agent</dt>
            <dd className="info-agent">
              <AgentBadge agent={s.agent} /> {s.agent}
            </dd>
            <dt>model</dt>
            <dd>{s.model ?? "?"}</dd>
            <dt>created</dt>
            <dd title={abs(s.createdAt)}>{fmtRel(s.createdAt)}</dd>
            <dt>updated</dt>
            <dd title={abs(s.updatedAt)}>{fmtRel(s.updatedAt)}</dd>
            <dt>turns</dt>
            <dd>{s.turnCount ?? 0}</dd>
            <dt>msgs</dt>
            <dd>{s.messageCount ?? 0}</dd>
            <dt>size</dt>
            <dd>{fmtSize(s.sizeBytes)}</dd>
            <dt>id</dt>
            <dd>
              <a
                className="sid"
                href={`?s=${encodeURIComponent(s.id)}`}
                title={`${s.id} — click to copy a link to this session`}
                onClick={(e) => {
                  e.preventDefault(); // plain click copies the deep link; cmd-click opens it
                  copyLink();
                }}
              >
                {shortId(s.id)}
                {copied ? " ✓ copied" : ""}
              </a>
            </dd>
          </dl>
          {s.tags?.length > 0 && (
            <div className="info-tags">
              {s.tags.map((t: string) => (
                <span key={t} className="tag-chip">
                  {t}
                </span>
              ))}
            </div>
          )}
          {s.notes && <p className="info-notes">{s.notes}</p>}
        </section>

        {summarizerAvailable && (
          <section className="info-sec">
            <div className="info-h-row">
              <h3 className="info-h">Summary</h3>
              {!summary && (
                <IconButton
                  label="summarize"
                  className={`ghost-btn${summarizing ? " on" : ""}`}
                  onClick={() => !summarizing && onSummarize(false)}
                >
                  <Sparkles size={13} className={summarizing ? "spin" : ""} />
                </IconButton>
              )}
            </div>
            {summaryError && <SummaryError error={summaryError} onDismiss={onDismissError} />}
            {summary ? (
              <SummaryCard
                summary={summary}
                refreshing={summarizing}
                onRefresh={() => !summarizing && onSummarize(true)}
                onRemove={onRemoveSummary}
              />
            ) : (
              !summaryError && <p className="info-empty">No summary yet.</p>
            )}
          </section>
        )}

        <section className="info-sec">
          <h3 className="info-h">
            Highlights {highlights.length > 0 && <span className="info-count">{highlights.length}</span>}
          </h3>
          {highlights.length === 0 ? (
            <p className="info-empty">Select text in the conversation to save a highlight.</p>
          ) : (
            <ul className="info-hl-list">
              {highlights.map((h) => (
                <li key={h.id} className="info-hl">
                  <button
                    className="info-hl-jump"
                    title="jump to this message"
                    onClick={() => onJumpHighlight(h)}
                  >
                    <span className="info-hl-quote">{h.text}</span>
                    {h.note && <span className="info-hl-note">{h.note}</span>}
                  </button>
                  <IconButton
                    label="remove highlight"
                    className="ghost-btn info-hl-x"
                    onClick={() => onRemoveHighlight(h.id)}
                  >
                    <X size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

// ── detail head (owns the typing-heavy state, isolated from MessageList) ─────
function DetailHead({
  session,
  resumeCommand,
  summary,
  summarizerAvailable,
  summarizing,
  onSummarize,
  expandAll,
  onToggleExpand,
  rawOpen,
  onToggleRaw,
  infoOpen,
  onToggleInfo,
  onDeleted,
}: {
  session: any;
  resumeCommand: string | null;
  summary: { text: string; createdAt: number } | null;
  summarizerAvailable: boolean;
  summarizing: boolean;
  onSummarize(force: boolean): void;
  expandAll: boolean;
  onToggleExpand(): void;
  rawOpen: boolean;
  onToggleRaw(): void;
  infoOpen: boolean;
  onToggleInfo(): void;
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
          {summarizerAvailable && (
            <IconButton
              label={summary ? "re-summarize" : "summarize"}
              className={`iconbtn${summarizing ? " on" : ""}`}
              onClick={() => !summarizing && onSummarize(!!summary)}
            >
              <Sparkles size={15} className={summarizing ? "spin" : ""} />
            </IconButton>
          )}
          <IconButton label={expandAll ? "collapse all" : "expand all"} onClick={onToggleExpand}>
            {expandAll ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
          </IconButton>
          <IconButton
            label={rawOpen ? "back to conversation" : "raw source"}
            className={`iconbtn${rawOpen ? " raw-on" : ""}`}
            onClick={onToggleRaw}
          >
            <FileCode size={14} />
          </IconButton>
          <IconButton label="delete" className="iconbtn danger" onClick={() => setConfirming(true)}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton
            label={infoOpen ? "hide info panel" : "show info panel"}
            className={`iconbtn${infoOpen ? " on" : ""}`}
            onClick={onToggleInfo}
          >
            {infoOpen ? <PanelRightOpen size={15} /> : <PanelRight size={15} />}
          </IconButton>
        </div>
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

// ── highlight-on-selection floating button ───────────────────────────────────
type PendingSelection = {
  x: number;
  y: number;
  text: string;
  messageUid: string | null;
  messageSeq: number | null;
};

/** Watch text selection inside `.messages`; when the user selects text within a single
 *  `.msg`, surface a floating "Highlight" button anchored above the selection. Selections
 *  that span multiple messages (or land outside .messages) are ignored. */
function useHighlightSelection(rootRef: React.RefObject<HTMLDivElement | null>) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  useEffect(() => {
    // Read rootRef.current LAZILY inside the handler — the messages pane mounts after
    // the loading state, and this effect's deps never change, so capturing root at
    // setup would leave the listeners permanently pointed at null.
    const check = () => {
      const root = rootRef.current;
      if (!root) return void setPending(null);
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return void setPending(null);
      const text = sel.toString().trim();
      if (!text) return void setPending(null);
      const range = sel.getRangeAt(0);
      // Resolve the enclosing chat message from the selection's ENDPOINTS, not its
      // commonAncestorContainer: a triple-click (select-paragraph) often reports a CAC
      // that bubbles above the `.msg` (to `.md`/`.messages`), which previously suppressed
      // the popover entirely. Both endpoints must land in the SAME chat message.
      const msgOf = (n: Node): Element | null =>
        (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest?.(".msg[data-seq]") ?? null;
      const startMsg = msgOf(range.startContainer);
      const endMsg = msgOf(range.endContainer);
      if (startMsg && endMsg && startMsg !== endMsg) return void setPending(null); // spans messages
      const msg = startMsg ?? endMsg;
      if (!msg || !root.contains(msg)) return void setPending(null);
      const rect = range.getBoundingClientRect();
      setPending({
        x: rect.left + rect.width / 2,
        y: rect.top,
        // Trim edge whitespace: a triple-click (select-paragraph) appends a trailing
        // newline that isn't in the rendered text node, which would break the exact
        // inline mark (the highlight would save but never render in the body). Inner
        // whitespace is preserved so the match against the source text stays exact.
        text: sel.toString().trim(),
        messageUid: msg.getAttribute("data-uid") || null,
        messageSeq: Number(msg.getAttribute("data-seq")),
      });
    };
    const onScroll = () => setPending(null);
    document.addEventListener("selectionchange", check);
    document.addEventListener("mouseup", check);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("selectionchange", check);
      document.removeEventListener("mouseup", check);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef]);
  return { pending, clear: () => setPending(null) };
}

/** Scroll to a message and flash it, reusing the `msg-<id>` anchor + `.jump` class. */
function jumpToMessage(msgId: number) {
  const el = document.getElementById(`msg-${msgId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("jump");
  setTimeout(() => el.classList.remove("jump"), 1800);
}

// ── detail ────────────────────────────────────────────────────────────────
export function Detail({
  id,
  targetMsgId,
  highlight,
  infoOpen,
  onToggleInfo,
  onDeleted,
  onProjectClick,
}: {
  id: string | null;
  targetMsgId: number | null;
  highlight: string;
  infoOpen: boolean;
  onToggleInfo(): void;
  onDeleted(): void;
  onProjectClick(project: string): void;
}) {
  const qc = useQueryClient();
  const [expandAll, setExpandAll] = useState(false);
  // Raw source view (debug): local state, not URL — a transient inspection mode that
  // shouldn't survive session switches (Detail is keyed by id) or land in deep links.
  const [rawOpen, setRawOpen] = useState(false);
  const [resetTick, setResetTick] = useState(0);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const { pending, clear } = useHighlightSelection(messagesRef);
  const { data, isLoading } = useQuery({
    queryKey: ["detail", id],
    queryFn: () => trpc.sessionDetail.query({ id: id! }),
    enabled: !!id,
  });
  const { data: summarizerAvailable = false } = useQuery({
    queryKey: ["summarizerAvailable"],
    queryFn: () => trpc.summarizerAvailable.query(),
    staleTime: Infinity,
  });

  const invalidateHl = () => {
    qc.invalidateQueries({ queryKey: ["detail", id] });
    qc.invalidateQueries({ queryKey: ["highlights"] });
  };
  const mAdd = useMutation({
    mutationFn: (v: { text: string; messageUid: string | null; messageSeq: number | null }) =>
      trpc.addHighlight.mutate({ sessionId: id!, ...v }),
    onSuccess: () => {
      invalidateHl();
      clear();
      window.getSelection()?.removeAllRanges();
    },
  });
  const mRemove = useMutation({
    mutationFn: (hid: number) => trpc.removeHighlight.mutate({ id: hid }),
    onSuccess: invalidateHl,
  });
  // Summary mutations live here (not in DetailHead) so both the head action and the
  // info panel drive the same logic without duplicating it.
  const mSummarize = useMutation({
    mutationFn: (force: boolean) => trpc.summarize.mutate({ id: id!, force }),
    onSuccess: (r) => {
      if (r.ok) {
        setSummaryError(null);
        qc.invalidateQueries({ queryKey: ["detail", id] });
      } else {
        setSummaryError(r.error);
      }
    },
    onError: (e: any) => setSummaryError(e?.message ?? "summarize failed"),
  });
  const mRemoveSummary = useMutation({
    mutationFn: () => trpc.removeSummary.mutate({ id: id! }),
    onSuccess: () => {
      setSummaryError(null);
      qc.invalidateQueries({ queryKey: ["detail", id] });
    },
  });
  const summarize = (force: boolean) => {
    if (!mSummarize.isPending) mSummarize.mutate(force);
  };

  useEffect(() => {
    if (!data || targetMsgId == null) return;
    jumpToMessage(targetMsgId);
  }, [data, targetMsgId]);

  // Map a highlight (uid/seq) to its message id, then jump. Prefer the uid (stable
  // across re-sync); fall back to positional seq.
  const jumpToHighlight = (h: { messageUid: string | null; messageSeq: number | null }) => {
    if (!data) return;
    const msg =
      (h.messageUid != null && data.messages.find((m) => m.uid === h.messageUid)) ||
      (h.messageSeq != null && data.messages.find((m) => m.seq === h.messageSeq)) ||
      null;
    if (msg) jumpToMessage(msg.id);
  };

  // Clicking an existing highlight mark asks to remove it (same confirm dialog the info
  // panel's ✕ uses, so both paths behave identically).
  const onMessagesClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const mark = target.closest?.("mark.hl") as HTMLElement | null;
    if (!mark) return;
    const hid = Number(mark.getAttribute("data-hl-id"));
    if (hid) setPendingRemove(hid);
  };

  // Text of the highlight awaiting removal (for the confirm dialog's quote).
  const pendingRemoveText =
    pendingRemove != null ? data?.highlights.find((h) => h.id === pendingRemove)?.text ?? null : null;

  if (!id) return <div className="detail-empty">Select a session to read it.</div>;
  if (isLoading || !data)
    return (
      <div className="detail">
        <div className="loading">loading…</div>
      </div>
    );

  return (
    <>
      <div className="detail">
        <DetailHead
          session={data.session}
          resumeCommand={data.resumeCommand}
          summary={data.summary}
          summarizerAvailable={summarizerAvailable}
          summarizing={mSummarize.isPending}
          onSummarize={summarize}
          expandAll={expandAll}
          onToggleExpand={() => {
            setExpandAll((v) => !v);
            setResetTick((t) => t + 1);
          }}
          rawOpen={rawOpen}
          onToggleRaw={() => setRawOpen((v) => !v)}
          infoOpen={infoOpen}
          onToggleInfo={onToggleInfo}
          onDeleted={onDeleted}
        />
        {rawOpen ? (
          // Full-pane swap: the raw dump wants the reader's whole width, and nothing
          // is fetched until this mounts (the "lazy" requirement for free).
          <RawView id={data.session.id} />
        ) : (
          <div ref={messagesRef} onClick={onMessagesClick} className="messages-scroll">
            <MessageList
              messages={data.messages}
              highlight={highlight}
              highlights={data.highlights}
              expandAll={expandAll}
              resetTick={resetTick}
            />
          </div>
        )}
        {pending && (
          <button
            className="hl-float"
            style={{ left: pending.x, top: pending.y }}
            // mousedown (not click) so the selection isn't cleared before we read it
            onMouseDown={(e) => {
              e.preventDefault();
              mAdd.mutate({
                text: pending.text,
                messageUid: pending.messageUid,
                messageSeq: pending.messageSeq,
              });
            }}
          >
            <Highlighter size={13} /> Highlight
          </button>
        )}
      </div>
      {infoOpen && (
        <>
          <Divider variant="info" />
          <InfoPanel
            session={data.session}
            summary={data.summary}
            summaryError={summaryError}
            onDismissError={() => setSummaryError(null)}
            summarizing={mSummarize.isPending}
            onSummarize={summarize}
            onRemoveSummary={() => mRemoveSummary.mutate()}
            summarizerAvailable={summarizerAvailable}
            highlights={data.highlights}
            onJumpHighlight={jumpToHighlight}
            onRemoveHighlight={(hid) => setPendingRemove(hid)}
            onProjectClick={onProjectClick}
          />
        </>
      )}
      <ConfirmDialog
        open={pendingRemove != null}
        title="Remove highlight?"
        body={
          <>
            This removes the saved highlight. The conversation text is unchanged.
            {pendingRemoveText && <span className="confirm-quote">“{pendingRemoveText}”</span>}
          </>
        }
        confirmLabel="Remove"
        onOpenChange={(o) => {
          if (!o) setPendingRemove(null);
        }}
        onConfirm={() => {
          if (pendingRemove != null) mRemove.mutate(pendingRemove);
          setPendingRemove(null);
        }}
      />
    </>
  );
}
