import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Pencil,
  Copy,
  Check,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import { Dialog, Tooltip, Checkbox, Button, Badge } from "@cloudflare/kumo";
import { trpc } from "./trpc.ts";
import { fmtRel, projLabel, shortId } from "./lib.ts";
import { AgentBadge } from "./rows.tsx";
import { MessageList } from "./messages.tsx";

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {}
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
      className="tip"
      render={
        <button className={className ?? "iconbtn"} aria-label={label} onClick={onClick}>
          {children}
        </button>
      }
    />
  );
}

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
  onProjectClick,
}: {
  session: any;
  resumeCommand: string | null;
  expandAll: boolean;
  onToggleExpand(): void;
  onDeleted(): void;
  onProjectClick(project: string): void;
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
        <span title={s.projectPath ? `${s.projectPath} — click to filter the list` : ""}>
          <span className="k">project</span>{" "}
          {s.projectPath ? (
            <button className="linklike" onClick={() => onProjectClick(s.projectPath)}>
              {projLabel(s.projectPath)}
            </button>
          ) : (
            projLabel(s.projectPath)
          )}
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
        <a
          className="sid"
          href={`?s=${encodeURIComponent(s.id)}`}
          title={`${s.id} — click to copy a link to this session`}
          onClick={(e) => {
            e.preventDefault(); // plain click copies the deep link; cmd-click opens it
            copy(`${location.origin}${location.pathname}?s=${encodeURIComponent(s.id)}`, "link");
          }}
        >
          {shortId(s.id)}
          {copied === "link" ? " ✓ link copied" : ""}
        </a>
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
export function Detail({
  id,
  targetMsgId,
  highlight,
  onDeleted,
  onProjectClick,
}: {
  id: string | null;
  targetMsgId: number | null;
  highlight: string;
  onDeleted(): void;
  onProjectClick(project: string): void;
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
        onProjectClick={onProjectClick}
      />
      <MessageList messages={data.messages} highlight={highlight} expandAll={expandAll} resetTick={resetTick} />
    </div>
  );
}
