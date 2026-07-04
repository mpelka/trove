import { useState, useEffect, useMemo, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fmtRel, rehypeHighlight, summarizeTools, buildItems } from "./lib.ts";

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

export const MessageList = memo(function MessageList(props: {
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
