import { type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, CornerDownRight } from "lucide-react";
import { Tabs } from "@cloudflare/kumo";
import { trpc } from "./trpc.ts";
import { fmtRel, fmtSize, shortId } from "./lib.ts";
import { SessionRow, MessageRow } from "./rows.tsx";

export type Selected = { id: string; msgId: number | null } | null;

export function Sidebar(props: {
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
