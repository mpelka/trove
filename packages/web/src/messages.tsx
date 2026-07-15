import { useState, useEffect, useMemo, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlighter } from "lucide-react";
import { fmtRel, rehypeHighlight, rehypeHighlightExact, summarizeTools, buildItems, type HL, type ToolCall } from "./lib.ts";

// A saved highlight, as the message list needs it (per-message grouping happens in MessageList).
export interface MsgHighlight {
  id: number;
  messageUid: string | null;
  messageSeq: number | null;
  text: string;
}

// ── messages (memoized so typing in the head doesn't re-render them) ─────────
const mdComponents = { a: (props: any) => <a {...props} target="_blank" rel="noopener noreferrer" /> };

const ChatMessage = memo(function ChatMessage(props: {
  id: number;
  uid: string | null;
  seq: number;
  role: string;
  text: string;
  ts: number | null;
  calls: ToolCall[]; // tool calls carried by THIS turn (gemini agentic turns)
  highlight: string;
  highlights: HL[]; // saved highlights anchored to THIS message
  expandAll: boolean;
  resetTick: number;
}) {
  const { id, uid, seq, role, text, ts, calls, highlight, highlights, expandAll, resetTick } = props;
  const [override, setOverride] = useState<boolean | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  useEffect(() => setOverride(null), [resetTick]);
  const open = override ?? expandAll;
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    return counts;
  }, [calls]);
  const long = text.length > 1400;
  const rehype = [
    ...(highlight.trim() ? [rehypeHighlight(highlight)] : []),
    ...(highlights.length ? [rehypeHighlightExact(highlights)] : []),
  ];
  // Fallback: a highlight whose exact text isn't in the raw source (markdown syntax split it,
  // or it spans nodes) can't be marked inline — flag the whole message so it's never invisible.
  const unmarkable = highlights.some((h) => !text.includes(h.text));
  return (
    <div
      className={`msg ${role}${highlights.length ? " has-hl" : ""}${unmarkable ? " hl-fallback" : ""}`}
      id={`msg-${id}`}
      data-uid={uid ?? ""}
      data-seq={seq}
    >
      <div className="who">
        <span className="dot" />
        {role === "user" ? "you" : role === "system" ? "system" : "assistant"}
        {highlights.length > 0 && (
          <Highlighter size={12} className="hl-glyph" aria-label="has highlights" />
        )}
        <span className="t">{fmtRel(ts)}</span>
      </div>
      {text && (
        <div className={`clampwrap${long && !open ? " clamped" : ""}`}>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype} components={mdComponents}>
              {text}
            </ReactMarkdown>
          </div>
        </div>
      )}
      {long && (
        <div className="more" onClick={() => setOverride(!open)}>
          {open ? "show less" : "show more"}
        </div>
      )}
      {calls.length > 0 && (
        <>
          <div className="tool-summary" onClick={() => setToolsOpen((o) => !o)}>
            <span className="caret">{toolsOpen ? "▾" : "▸"}</span>
            {summarizeTools(toolCounts)}
          </div>
          {toolsOpen && (
            <ul className="tool-calls">
              {calls.map((c, i) => (
                <li key={i}>
                  <span className="tc-name">{c.name}</span>
                  {c.input && <code className="tc-input">{c.input}</code>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
});

function ToolGroup({
  id,
  summary,
  calls,
  ts,
}: {
  id: number;
  summary: string;
  calls: ToolCall[];
  ts: number | null;
}) {
  const [open, setOpen] = useState(false);
  // Expandable only when we actually have per-call detail to show.
  const canExpand = calls.length > 0;
  return (
    <div className="msg tool" id={`msg-${id}`}>
      <div className="who">
        <span className="dot" />
        tools<span className="t">{fmtRel(ts)}</span>
      </div>
      <div
        className={`text${canExpand ? " expandable" : ""}`}
        onClick={canExpand ? () => setOpen((o) => !o) : undefined}
      >
        {canExpand && <span className="caret">{open ? "▾" : "▸"}</span>}
        {summary}
      </div>
      {open && canExpand && (
        <ul className="tool-calls">
          {calls.map((c, i) => (
            <li key={i}>
              <span className="tc-name">{c.name}</span>
              {c.input && <code className="tc-input">{c.input}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const MessageList = memo(function MessageList(props: {
  messages: { id: number; uid: string | null; seq: number; role: string; text: string; timestamp: number | null; tool_calls?: string | null }[];
  highlight: string;
  highlights: MsgHighlight[];
  expandAll: boolean;
  resetTick: number;
}) {
  const items = useMemo(() => buildItems(props.messages), [props.messages]);
  // Group highlights onto messages by uid (stable) first, else by seq. Only unresolved-by-uid
  // highlights fall back to seq so a uid match always wins.
  const byMsg = useMemo(() => {
    const uidToId = new Map<string, number>();
    const seqToId = new Map<number, number>();
    for (const m of props.messages) {
      if (m.uid) uidToId.set(m.uid, m.id);
      seqToId.set(m.seq, m.id);
    }
    const map = new Map<number, HL[]>();
    for (const h of props.highlights ?? []) {
      let mid: number | undefined;
      if (h.messageUid && uidToId.has(h.messageUid)) mid = uidToId.get(h.messageUid);
      else if (h.messageSeq != null) mid = seqToId.get(h.messageSeq);
      if (mid == null) continue; // orphaned highlight — nothing to mark in this session
      const arr = map.get(mid) ?? [];
      // Trim edge whitespace so highlights saved before the capture-side trim (e.g. a
      // triple-click's trailing newline) still match a rendered text node and mark inline.
      arr.push({ id: h.id, text: h.text.trim() });
      map.set(mid, arr);
    }
    return map;
  }, [props.messages, props.highlights]);

  return (
    <div className="messages">
      {items.map((it) =>
        it.kind === "tools" ? (
          <ToolGroup key={it.id} id={it.id} summary={summarizeTools(it.counts)} calls={it.calls} ts={it.ts} />
        ) : (
          <ChatMessage
            key={it.id}
            id={it.id}
            uid={it.uid}
            seq={it.seq}
            role={it.role}
            text={it.text}
            ts={it.ts}
            calls={it.calls}
            highlight={props.highlight}
            highlights={byMsg.get(it.id) ?? EMPTY_HL}
            expandAll={props.expandAll}
            resetTick={props.resetTick}
          />
        ),
      )}
    </div>
  );
});

const EMPTY_HL: HL[] = [];
