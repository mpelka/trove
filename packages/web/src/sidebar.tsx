import { type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, ArrowDown, ArrowUp, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover.tsx";
import { trpc } from "./trpc.ts";
import { fmtRel, fmtSize, shortId, projLabel } from "./lib.ts";
import { AGENTS } from "./palette-actions.ts";
import { SessionRow, MessageRow, HighlightRow } from "./rows.tsx";

export type Selected = { id: string; msgId: number | null } | null;

export function Sidebar(props: {
  query: string;
  agent: string | undefined;
  setAgent(a: string | undefined): void;
  /** Agent ids that get a filter chip on this machine (chip-visibility.ts decides;
   *  App computes). Chrome only — queries below are never filtered by this. */
  visibleAgents: string[];
  project: string | null;
  setProject(p: string | null): void;
  starOnly: boolean;
  sort: "relevance" | "recent";
  setSort(s: "relevance" | "recent"): void;
  view: "sessions" | "messages";
  setView(v: "sessions" | "messages"): void;
  bsort: "updated" | "created";
  setBsort(v: "updated" | "created"): void;
  order: "desc" | "asc";
  setOrder(v: "desc" | "asc"): void;
  hlView: boolean;
  selected: Selected;
  onSelect(s: Selected): void;
}) {
  const qc = useQueryClient();
  const {
    query, agent, setAgent, visibleAgents, project, setProject, starOnly,
    sort, setSort, view, setView, bsort, setBsort, order, setOrder, hlView, selected, onSelect,
  } = props;
  const searching = query.trim().length > 0 && !hlView;

  const listQ = useQuery({
    queryKey: ["list", agent, starOnly, project, bsort, order],
    queryFn: () =>
      trpc.list.query({
        agent,
        star: starOnly,
        project: project ?? undefined,
        limit: 200,
        sort: bsort,
        order,
      }),
    enabled: !searching && !hlView,
  });
  const searchQ = useQuery({
    queryKey: ["search", query, agent, starOnly, project, sort, view],
    queryFn: () =>
      trpc.search.query({
        query,
        agent,
        star: starOnly,
        project: project ?? undefined,
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

  const hlQ = useQuery({
    queryKey: ["highlights"],
    queryFn: () => trpc.highlights.query({ limit: 300 }),
    enabled: hlView,
  });

  const star = useMutation({
    mutationFn: (v: { id: string; starred: boolean }) => trpc.setStar.mutate(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["list"] });
      qc.invalidateQueries({ queryKey: ["search"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const loading = hlView ? hlQ.isLoading : searching ? searchQ.isLoading : listQ.isLoading;
  let body: ReactNode = null;
  let count = 0;

  if (hlView && hlQ.data) {
    count = hlQ.data.length;
    body = hlQ.data.map((h) => (
      <HighlightRow
        key={h.id}
        text={h.text}
        note={h.note}
        name={h.sessionName}
        agent={h.agent}
        ts={h.createdAt}
        selected={selected?.id === h.sessionId && h.messageId != null && selected?.msgId === h.messageId}
        onSelect={() => onSelect({ id: h.sessionId, msgId: h.messageId })}
      />
    ));
  } else if (searching && searchQ.data?.kind === "messages") {
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
  } else if (!searching && !hlView && listQ.data) {
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
      {/* ONE row (wrap allowed in search mode): agent chips · spacer · sort · count.
          In browse mode it stays a single ~45px band that bottom-aligns with the
          reader's .detail-head; starred/highlights toggles live on the rail now. */}
      <div className="sidebar-top">
        <div className="filters">
          <button className={`chip${!agent ? " on" : ""}`} onClick={() => setAgent(undefined)}>
            all
          </button>
          {/* Chips are per-machine chrome: agents with no sessions (or manually
              unchecked in settings) get no chip — but an ACTIVE filter always
              shows its chip, so deep links stay legible. Never filters queries. */}
          {AGENTS.filter((a) => visibleAgents.includes(a.id)).map((a) => (
            <button key={a.id} className={`chip${agent === a.id ? " on" : ""}`} onClick={() => setAgent(a.id)}>
              {a.chip}
            </button>
          ))}
          {project && (
            <button className="chip on projchip" title={`${project} — click to clear`} onClick={() => setProject(null)}>
              {projLabel(project)} <X size={11} />
            </button>
          )}
          <span className="ftail">
            {!searching && !hlView && (
              /* Browse sort, folded into one compact trigger: "↓ activity" / "↑ created".
                 The popover holds the same sort-by pair + order toggle as before. */
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="chip orderbtn"
                    title={`sorted by ${bsort === "updated" ? "last activity" : "created date"}, ${order === "desc" ? "newest" : "oldest"} first — click to change`}
                  >
                    {order === "desc" ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                    {bsort === "updated" ? "activity" : "created"}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="end" className="sort-pop">
                  <span className="lbl">sort by</span>
                  <Tabs className="seg" value={bsort} onValueChange={(v) => setBsort(v as "updated" | "created")}>
                    <TabsList>
                      <TabsTrigger value="updated">Last activity</TabsTrigger>
                      <TabsTrigger value="created">Created</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <button
                    className="chip orderbtn"
                    title={order === "desc" ? "newest first — click for oldest first" : "oldest first — click for newest first"}
                    onClick={() => setOrder(order === "desc" ? "asc" : "desc")}
                  >
                    {order === "desc" ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                    {order === "desc" ? "newest first" : "oldest first"}
                  </button>
                </PopoverContent>
              </Popover>
            )}
            {searching && (
              /* Search keeps its two segmented controls inline; the row may wrap
                 to a second line here — the one-row guarantee is browse-only. */
              <>
                <Tabs className="seg" value={sort} onValueChange={(v) => setSort(v as "relevance" | "recent")}>
                  <TabsList>
                    <TabsTrigger value="relevance">Best match</TabsTrigger>
                    <TabsTrigger value="recent">Recent</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Tabs className="seg" value={view} onValueChange={(v) => setView(v as "sessions" | "messages")}>
                  <TabsList>
                    <TabsTrigger value="sessions">Conversations</TabsTrigger>
                    <TabsTrigger value="messages">Messages</TabsTrigger>
                  </TabsList>
                </Tabs>
              </>
            )}
            <span className="count">{loading ? "…" : count}</span>
          </span>
        </div>
      </div>
      <div className="list">
        {!hlView && idHit && (
          <a
            className="row idrow"
            href={`?s=${encodeURIComponent(idHit.sessionId)}${idHit.messageId != null ? `&m=${idHit.messageId}` : ""}`}
            onClick={(e) => {
              e.preventDefault(); // plain click = in-app select; cmd-click/copy-link still work
              onSelect({ id: idHit.sessionId, msgId: idHit.messageId });
            }}
          >
            <div className="top">
              <CornerDownRight size={14} />
              <span className="name">
                open {idHit.kind} · {shortId(idHit.sessionId)}
                {idHit.messageId != null ? ` · msg #${idHit.messageId}` : ""}
              </span>
            </div>
          </a>
        )}
        {loading && <div className="loading">{hlView ? "loading highlights…" : "searching…"}</div>}
        {!loading && count === 0 && !idHit && (
          <div className="loading">
            {hlView
              ? "No highlights yet. Select text in a conversation to save one."
              : searching
                ? "No matches."
                : "No sessions."}
          </div>
        )}
        {body}
      </div>
    </div>
  );
}
