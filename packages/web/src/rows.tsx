import { Star, Asterisk, Sparkle, Bot, Orbit } from "lucide-react";
import { Badge } from "@cloudflare/kumo";
import { fmtRel, agentClass, agentLabel, projLabel } from "./lib.ts";

export function Snippet({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

// Agent marker: a small round, tinted logo per agent. Generic glyphs (not the official
// trademarked logos): claude=asterisk, gemini=sparkle, copilot=bot, antigravity=orbit.
export const AgentIcon = ({ agent }: { agent: string }) =>
  agent === "claude-code" ? <Asterisk size={15} strokeWidth={2.6} />
  : agent === "gemini-cli" ? <Sparkle size={13} strokeWidth={2.1} />
  : agent === "antigravity" ? <Orbit size={13} strokeWidth={2.1} />
  : <Bot size={13} strokeWidth={2.1} />;

export function AgentBadge({ agent }: { agent: string }) {
  return (
    <span className={`agentlogo ${agentClass(agent)}`} title={agent} aria-label={agentLabel(agent)}>
      <AgentIcon agent={agent} />
    </span>
  );
}

export function SessionRow(p: {
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

export function HighlightRow(p: {
  text: string;
  note: string | null;
  name: string;
  agent: string;
  ts: number | null;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <div className={`row hlrow${p.selected ? " sel" : ""}`} onClick={p.onSelect}>
      <div className="hl-quote">{p.text}</div>
      {p.note && <div className="hl-note">{p.note}</div>}
      <div className="top">
        <AgentBadge agent={p.agent} />
        <span className="name">{p.name || "(untitled)"}</span>
      </div>
      <div className="sub">
        <span>{fmtRel(p.ts)}</span>
      </div>
    </div>
  );
}

export function MessageRow(p: {
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
