# trove — Build Plan

*A local librarian, search engine, and archive for your CLI coding-agent sessions.*

*A starting point for Claude Code, not a finished spec. Anything about exact paths, file
shapes, field names, or flag behaviour below is **provisional** — treat Phase 0 as the source
of truth and correct this document from what you actually find on the machine.*

*Scope: archive, **search**, and browse local sessions from **multiple CLI agents** — reference
adapter **claude-code** (built and tested on the dev machine), then the work targets **gemini-cli**
and **copilot-cli** (plus **antigravity/agy**), structured so the next is just another adapter.*

---

## Goal

A **local, read-only browser, search engine, and archive** over the session history of my CLI
coding agents. It lets me give sessions custom names, star them, tag them, sort them, **search
their full contents fast**, and — crucially — **preserve** the valuable ones permanently. Most
of my PR-review sessions surface something worth keeping, across both gemini-cli and
copilot-cli, and today they're near-impossible to find and quietly at risk of deletion.

**North-star flow:** *"I remember discussing X with gemini but can't find the session, and
`gemini --list-sessions` takes forever — I just want to type a query, find it instantly, then read
it or relaunch it."* Fast keyword search → read the archived transcript → optionally resume. A GUI
this time, not another clunky CLI-only tool — focused on that one flow done well.

This is a *librarian for finished sessions*, not a cockpit for live ones. It is explicitly
**not** a chat UI, and it does **not** drive any agent as a live backend.

## Core principles (these encode decisions already made — please keep them)

- **Read-only w.r.t. each agent's own files.** Discover, parse, copy out — never mutate in place.
- **Archive on ingest (slim canonical, latest-wins).** The first time the tool sees a session,
  extract its *chat content* — user + assistant text, **code blocks kept**, thinking blocks and
  large tool-call payloads dropped (keep a lightweight tool-name marker) — into our own store, so
  the archive outlives each agent's retention cleanup, deletion of the originating worktree, and
  any agent CLI being EOL'd. On change, re-extract and overwrite (**latest-wins**; "immutable" was
  the wrong word). Optionally also keep the raw source **gzip-compressed** as a prunable safety net
  (e.g. for starred sessions or N days) — a stripping decision you regret is otherwise
  unrecoverable once the source is gone. Upstream disappearance must never lose a session's meat.
- **Sidecar metadata.** My custom names / stars / tags / notes live in a separate store keyed by
  session id, never inside the source files.
- **Works without any agent running or installed.** The core (search / browse / preserve) reads
  archived data only. Only optional features (resume, generating new sessions) may depend on an
  agent being alive.
- **Agent-agnostic core, per-agent adapters.** Everything above the adapter layer works on one
  normalized shape and never special-cases a tool. All tool-specific knowledge is inside adapters.
- **Search is keyword-first and deterministic.** Full-text (SQLite FTS5), no AI calls in the hot
  path, instant and reproducible. Semantic/vector search is **explicitly out of scope for v1**:
  keyword covers ~95% of the need, the ONNX semantic search in our prior tools barely helped in
  practice, and a locked-down work laptop may block model downloads entirely — so **v1 must run
  with zero network and zero model download**. Leave a clean seam to add it later, but don't build
  it now.
- **Incremental indexing.** Index once, update only changed sessions. This is why it feels
  instant where the native `--list-sessions`-style commands crawl.
- **Local, single-user, offline.** No auth, no external network. A localhost web app is fine.

## Adapter interface (the central abstraction)

One adapter per agent; the core discovers registered adapters and treats them uniformly. The
contract is about *records out*, not *files in* — a source might be a directory of files **or a
database** (see Prior art), so adapters abstract the storage medium away. Each adapter provides,
roughly:

- `agentId` — stable identifier (`"gemini"`, `"copilot"`).
- `discoverLocations()` — where this tool keeps sessions on this machine (may be several).
- `enumerate() -> SourceRef[]` — find session artifacts; a `SourceRef` is **medium-neutral** (a
  file path **or** a `(db, rowId)` pair), since half the known sources are SQLite DBs, not files
  (see Ground truth).
  Recognition is the adapter's job, not the core's — don't leak a file model upward.
- `parse(source) -> NormalizedSession + messages[]` — map raw content to the common shape;
  stash anything that doesn't fit in an `agentSpecific` blob rather than dropping it. Supply
  message parent links if the format has them (see tree/context under Indexing).
- `resolveProject(session)` — best-effort origin repo/worktree path (may be gone).
- `buildResumeCommand(session)` — optional; how to resume *this* tool's session; absent if
  unsupported.
- `postSessionHook()` / `nativeCleanupInfo()` — optional; how to trigger a reindex when a
  session ends, and what the tool's own retention does (so we can warn).

Prove the interface with the **Claude Code adapter first** as reference (richest sessions, present
on the dev machine, biggest archive-slimming payoff); get the whole pipeline working end-to-end
with it; then add **gemini-cli** (the work target). Adding the second tool should require **no
changes above the adapter layer** — if it does, the abstraction is wrong.

## Phase 0 — Establish ground truth (discover, don't assume)

Before writing the store or adapters, inspect the real environment and the synthetic sessions
for **each** tool, generate one or two more per tool to see how the shape varies, and **pin the
version of each CLI**. For **every** supported agent, nail down empirically:

- **Where sessions actually live** (all relevant locations) and the storage medium (files vs DB).
- **The real on-disk shape.** Format; where the message/turn list lives; how user vs assistant vs
  tool-call entries are represented; **whether messages carry parent links / branch** (rewind,
  checkpoints); timestamps (created + last-updated); model(s); any stored title/summary; token or
  turn counts; the session id; and any embedded originating project path.
- **How a session maps back to a real directory** (origin repo/worktree), including when deleted.
- **What the CLI exposes for listing/resuming/deleting, and how slowly.**
- **The tool's own retention / cleanup behaviour** and current config (recommend loosening it as
  a stopgap), plus any **post-session hook** mechanism we can use to trigger reindexing.
- **Associated side files** (logs, plans, tool outputs) — decide which to archive.

**Known provisional leads (verify, don't trust):**

- **gemini-cli** — **now verified on the dev machine (see Ground truth):** the
  `~/.gemini/tmp/<project>/chats/` lead was right (slug or `sha256(path)`, not `~/.gemini/projects/`);
  `sessionRetention.maxAge:"30d"` exists but isn't enforced. Resume surface confirmed
  (`--resume`/`-r`, `--session-file`, `--list-sessions`, `--delete-session`). Work machine still TBD.
- **copilot-cli** — **now verified** (see Ground truth): a single SQLite DB at
  `~/.copilot/session-store.db`. Remaining unknowns: resume mechanism and retention/cleanup.

## Ground truth (verified 2026-07-03, dev machine)

*Discovered empirically on the private laptop. The **work machine** (gemini-cli + copilot only)
is not yet probed — versions and paths there may differ; confirm before relying on them.*

- **Claude Code** — v2.1.197. `~/.claude/projects/<url-encoded-cwd>/<uuid>.jsonl`, one JSONL per
  session (append-only, line-delimited). Entry `type`s: `user`, `assistant`, `tool_use`,
  `tool_result`, `attachment`, `mode`, `permission-mode`, `file-history-snapshot`. Per message:
  `uuid`, `parentUuid`, `isSidechain`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`;
  assistant `message.content` is a block array (`text` / `tool_use` / thinking); `message.usage`
  carries token counts. **Branch links: `parentUuid` + `isSidechain`.** Origin cwd is embedded (dir
  name and per-entry `cwd`). **This is the space problem: projects up to 160M, single sessions up
  to 72M**, almost all tool_result blobs + thinking — exactly what the slim canonical extract drops.
  **Verified while building the adapter:** identity must be the `.jsonl` **filename stem**, not the
  in-content `sessionId` (shared across resumes and subagents — one id spanned 73 files); subagent
  transcripts live at `<session>/subagents/agent-*.jsonl` (`isSidechain:true`, parent's `sessionId`)
  and are filtered as noise. Measured slim payoff: 450M of top-level sources → a ~32M FTS index
  (~14×); 93 sessions / ~40k messages in ~3s.
- **Copilot CLI** — v1.0.67 (`/opt/homebrew/bin/copilot`). **Single SQLite DB** at
  `~/.copilot/session-store.db` (WAL). Tables: `sessions`, `turns`, `checkpoints`,
  `dynamic_context_items`, `forge_trajectory_events`, `search_index*`. Small so far (240K, 19
  sessions). Branch/rewind via `checkpoints`. Adapter reads rows, not files.
- **Antigravity / agy** — v1.0.14 (`~/.local/bin/agy`). **One SQLite DB per conversation** at
  `~/.gemini/antigravity-cli/conversations/<uuid>.db`, plus `history.jsonl` (command history only).
  Per-conversation tables: `steps`, `trajectory_meta`, `parent_references`, `gen_metadata`,
  `executor_metadata`. ~10M total. Branch via `parent_references`.
- **gemini-cli** — **verified**, v0.47.0 (npm global `@google/gemini-cli`; oauth-personal; default
  model `gemini-3-flash-preview`). Sessions **auto-record** (no `/chat save` needed) to
  `~/.gemini/tmp/<project>/chats/session-<localISO>-<shorthash>.json`, one JSON file per session.
  `<project>` = slug from `~/.gemini/projects.json` (path→slug) for known dirs, else the 64-hex
  `sha256(abs path)`; a sibling `.project_root` stores the plaintext origin path, so `resolveProject`
  is a file read (and `session.projectHash == sha256(project_root)`, verified). Session JSON:
  `{ sessionId, projectHash, startTime, lastUpdated, kind, messages[] }`; `kind ∈ {main, subagent,
  null(legacy)}` — **subagent runs are separate session files with no in-file link to their parent**
  (decide: filter, or group as related). Message:
  `{ id, timestamp, type, content, thoughts?, tokens?, model? }`; `type ∈ {user, gemini, info, error}`
  (gemini→assistant; info/error are system strings). Assistant `content` is a **plain string**; user
  `content` is an **array** of `{text | functionResponse | inlineData}` parts (or a string).
  `thoughts[]` (reasoning) and `inlineData` (base64) are the bulk and are **dropped by slim
  extraction**; `functionResponse` bodies drop to a marker; `tokens.total` gives turn counts. **No
  parent links → flat/linear** (tree degrades to a list). Retention
  `general.sessionRetention.maxAge:"30d"` (settings.json) is **not enforced in practice** — Jan–Mar
  files survive into July, so archival matters but the 30d window isn't strict. Sizes 700 B – 33 MB
  (35 sessions, 69 MB) — same slim-extraction payoff as Claude Code. **Resume:
  `gemini --session-file <path.json>` loads a full session JSON from anywhere, so trove's kept raw
  copy stays resumable even after upstream deletion** — a strong reason to keep the optional raw; the
  slim copy won't round-trip. (`--resume latest|N` also works but is per-cwd and index-fragile.)

**Implication for the adapter contract:** the four sources split evenly by medium — **files**
(Claude Code JSONL, gemini-cli per-session JSON) and **SQLite** (copilot = one shared DB, agy = one
DB per conversation). Discovery must be **medium-neutral from day one** — not a later accommodation.

## Normalized data model (abstract — final field names come from Phase 0)

**`session` (imported/immutable record)** — id (namespaced so ids are unique *across* agents,
e.g. `agent + nativeId`), **agent**, source_path/medium, resolved project_path (nullable),
created_at, updated_at, size_bytes, turn_count (nullable), model(s) (nullable),
source_title/summary, `agentSpecific` blob, reference to the archived slim-canonical copy (and the
optional compressed raw), imported_at, content_hash.

**`message` (for search + context)** — id, session_id, seq, role (user/assistant/tool),
parent_id (nullable; enables branch tree), timestamp, text, and a reference back to the raw entry.
Storing messages individually is what enables in-session search, context expansion, and tree view.

**`session_meta` (user-owned, mutable)** — session_id, custom_name, starred, tags[], notes,
pinned, hidden. Its own table so re-imports never clobber my edits.

**FTS5 virtual table** over message text (see Indexing for what goes in it).

Keep the archived slim-canonical copy as the source of truth (latest-wins on re-ingest) and derive
everything else. Store: SQLite (bun:sqlite; Drizzle for typed access; FTS5 for search).

## Ingestion / sync

- Per adapter: discover, enumerate, and upsert only sessions that are new or changed (**hash-based**,
  not mtime-only — claude-search's mtime-only check misses same-mtime edits). Extract the
  slim-canonical chat into the archive store on first sight (overwrite latest-wins on change), then
  index.
- **Incremental + idempotent**; safe to run repeatedly, across all agents.
- **Background auto-index with a TTL cooldown** (e.g. a short incremental interval + a long full
  interval, both env-tunable) so it stays fresh without ever blocking a command. Trigger a reindex
  from each agent's **post-session hook** where one exists, so the index is current the moment a
  session ends.
- **Filter noise at ingest:** skip the librarian's own sessions and empty/trivial ones so results
  don't self-pollute.
- If a session vanishes upstream, **keep** the archived copy and mark the source as gone; never
  delete on the tool's side.

## Indexing & search (the priority — build this rich and early)

- **Engine: SQLite FTS5.** Deterministic, instant, no network/AI. This is the whole search story
  for v1.
- **Index full message text for best recall by default.** Robust recall matters more to me than a
  tiny index. Their prior-art "hybrid extraction" trick (index full user text but only the
  head/tail of long assistant messages) is a good **fallback lever if index size ever hurts** —
  keep it available behind a flag, but default to full-content indexing. Either way the *archive*
  always keeps the complete raw transcript; extraction only ever affects the index.
- **Message-level index with `parent_id`** to support:
  - `context` — expand N messages of surrounding context around a hit (walk the tree).
  - `tree` — show a session's branch structure (rewinds/checkpoints), where the adapter supplies
    parent links; degrade gracefully to a flat list when it doesn't.
- **Query surface (all composable, all with `--json`):**
  - keyword search across all agents; `--exact` for phrase matching; `--group-by-session`.
  - filters: `--agent`/`--source`, `--star`, `--tag`, `--project`, and repo-scoped `--here`
    (detect the current git root).
  - dates: absolute (`--since`/`--until`) and relative (`--date yesterday`, `--days N`), shown in
    local time.
- **`status`** command: index health/coverage (counts per agent, last index time, staleness).
- Semantic/vector search is deliberately deferred; keep the message text + a stable id available
  so embeddings could be layered on later without reshaping anything.

## Features

**MVP**
- **`search`** — the rich FTS5 query surface above (keyword, `--exact`, filters, dates, `--json`).
- **`pick`** — interactive `fzf` picker with live full-text search; `--here` to scope to the
  current repo; `eval "$(trove pick)"` to pick-and-resume in one step. Near-free, and it's a usable
  librarian before any web UI exists.
- **`sync`** / **`list`** / **`status`**.
- List/browse with sortable columns: name (custom, else summary/first user message), **agent**
  badge, star, turns, size, created, updated, origin project; sort by any; filter by
  agent/star/tag/project/date.
- Rename, star/unstar, tag, notes.
- Read-only detail view rendering the conversation, tolerant of each agent's shape, with `context`
  and `tree`.

**Later / optional**
- **Resume** → run the adapter's resume command in the resolved cwd; degrade gracefully if the
  agent is absent, unsupported, or the path is gone.
- **Export** a session or a branch (markdown / JSON) for an external knowledge base.
- **Claude Code skill/plugin** wrapping the CLI with query classification (topic vs temporal vs
  hybrid) so I can search from inside Claude Code — and since the tool spans gemini + copilot, that
  effectively lets Claude Code search my other agents' history too. Auto-install if missing.
- **Insight extraction** — optional "summarise the useful bits", clearly separate from the offline
  core.
- Group / detect by project or Jira ticket (parse ticket ids), cutting across agents.

## Architecture & packages

Two front ends over one set of operations: a **CLI** (for me *and* for agents — "find the
conversation where we discussed X") and a **web GUI**. A Bun workspace monorepo with a shared
tRPC surface fits this exactly — same shape as my home dashboard (Bun + tRPC `createCaller` +
TanStack Query + Drizzle over bun:sqlite). tRPC only appears where it earns its keep; the domain
logic stays framework-free.

**Package layering** (`packages/*`, Bun workspaces — no Turborepo unless the build graph grows):

- **`@trove/core`** — adapters, ingestion/indexing, Drizzle/SQLite access, search queries,
  metadata mutations. **Plain TypeScript, framework-free.** This is the real domain contract and
  where all the weight lives.
- **`@trove/api`** — the tRPC router built on core: procedures + zod input validation + context.
  The shared *operations* contract. Keep it thin — mostly a re-exposure of core with schemas,
  not new logic.
- **`@trove/cli`** — commander; builds a context and uses `createCaller(ctx)` to invoke the same
  procedures directly. **No HTTP server involved.**
- **`@trove/server`** — Bun HTTP host exposing the same router over tRPC (httpBatchLink) for the
  browser.
- **`@trove/web`** — React + TanStack Query + tRPC client.

`createCaller` is what lets CLI and server share one router — identical validation and error
shapes, zero drift — while only the GUI pays for a network hop. Don't over-split early: 4–5
packages is plenty; don't give each adapter its own package until there's real pain. commander is
fine; citty/clipanion only warrant a look if nested-command ergonomics get fiddly.

**Gotcha 1 — who owns indexing.** The background indexer must **not** be server-owned, or a
pure-CLI call (agent asking, GUI not running) could hit a stale index. Keep sync/index in
`@trove/core`, callable from both. The CLI does a **cooldown-gated JIT incremental sync before
searching** (the TTL-throttled indexing already specified), so it's self-sufficient with the
server down; the server runs the same sync on a loop plus the post-session hook.

**Gotcha 2 — SQLite concurrency.** CLI-via-`createCaller` is a *separate process* opening the
same DB file as a running GUI server, so two writers (the indexer especially) touch one SQLite
file. Enable **WAL mode + a `busy_timeout`** — for a single-user local tool that's genuinely
enough. If ever needed airtight: have the CLI prefer a detected running server's HTTP API and
fall back to `createCaller` only when it's down (one DB owner at a time) — but not on day one.

**Other stack notes:**
- Adapters as isolated modules registered with core; no tool-specific code leaks upward.
- **No always-on daemon** (keeps the already-hot corpo laptop cool): the CLI stays fresh via a
  cooldown-gated JIT sync before search, plus the per-agent **post-session hook** (fires only when a
  session ends — one reindex, then idle). Any background loop is **server-only** — it runs solely
  while the GUI is open. Long native retention (already loosened at work) covers the rest.
- Web GUI is a localhost app (Astro or a lightweight SPA), leaving the door open to a browser tab
  / tab group later. `pick` is the terminal-native front end and lands first.
- Read-only access to each agent's store; own writable data dir elsewhere (e.g. an XDG data dir or
  `~/.trove/`). No auth; server binds localhost only.

**Sequencing that falls out of this:** build `@trove/core` + `@trove/cli` first (that's the
"search early" milestone, step 4) and let `@trove/api` arrive as a thin layer when the GUI starts
— since the CLI proves the operations against core directly, the router becomes mostly schema +
re-exposure rather than new logic.

## Non-goals & cautions

- **No semantic/vector search in v1** — deterministic FTS5 only; leave a seam, don't build it.
- **Don't** reimplement any agent's chat UI or drive it as a live backend.
- **Don't** mutate, migrate, or clean up any agent's own store.
- **Don't** index a *pointer only* (session id + path) the way the prior-art tools do — that
  breaks when the source is deleted or cleaned up. Archive the raw content so search and view keep
  working forever.
- **Don't** assume schema stability across versions **or** similarity between agents — pin each
  version, keep each adapter tolerant (ignore unknown fields, fail soft). One tool's format drift
  must never break another's adapter.
- **Privacy:** sessions from either tool may contain corporate code and secrets. Keep everything
  local and gitignore the archive/data dir.

## Prior art (what we're lifting, and where we go further)

Validated against `akatz-ai/cc-conversation-search` (Python, Claude Code only) and its fork
`yoshi47/ai-conversation-search` (Rust; Claude Code + OpenCode + Codex).

**Two of these we've actually run.** **`claude-search`** (`~/Sites/GitHub/claude-search`) is *our*
TypeScript port of akatz's Python tool with extra features: Bun/TS, FTS5 + optional local ONNX
embeddings, RRF hybrid; its `messages` schema — `parent_uuid`, `role`, `content`,
`content_normalized`, `is_tool_noise`/`is_meta`/`is_summary`, FTS5 triggers — is ~90% of our
`message` table; strips thinking, flags tool-noise. **`pickbrain`** (`~/Sites/GitHub/witchcraft`;
Rust, T5 + centroid-ANN, multi-source) is **external** (believed Dropbox's), cloned only to
evaluate — not ours.

**The lived lesson from both: the semantic search barely earns its keep.** Even with ONNX it's
clunky and rarely beats plain keyword for "find that conversation." That, plus the fact this ships
to a **locked-down corpo laptop where downloading a model may be blocked**, is why v1 is
keyword-only and must run with **zero network / zero model download** — the ONNX path stays as
reference code behind an off-by-default seam, nothing we depend on. Both tools also stayed clunky
CLI-only; trove's answer is to **stay focused and add a GUI**. And what neither has: **they don't
preserve, and they have no user-owned metadata** — trove's reason to exist. `pickbrain` further
shows the failure we fix: byte-offsets into the *original* JSONL, seeked at render time — instant,
and instantly broken the moment retention deletes the file. Lift ideas; fork neither (greenfield).

- **Lifted:** per-source indexer modules = the adapter pattern (the fork proves it, incl. a source
  that's a *SQLite DB* rather than files); namespaced ids + source labels + `--source` filter;
  FTS5 keyword search with `--exact` and `--group-by-session`; message-level rows with parent links
  enabling `context`/`tree`; JIT + background indexing with TTL cooldown and a post-session hook;
  calendar + relative date filters; meta-conversation filtering; `pick` (fzf) with one-step resume
  and `--here`; `--json` everywhere; `status`; Claude Code skill packaging with query classification.
- **Where we go further (our differentiators):** neither tool *preserves* anything — they index a
  pointer and lean on native `--resume`, so they break when the source is gone. We archive on
  ingest. And neither has **user-owned metadata** (custom names, stars, tags) — that sidecar is our
  reason to build rather than just install the fork.
- **Note:** despite "semantic search" in the akatz description, both are deterministic FTS5 + smart
  extraction — no embeddings. Consistent with our keyword-first, semantic-later stance.

## Suggested build order

1. Phase 0 discovery — **done for Claude Code / copilot / agy / gemini-cli** on the dev machine
   (see Ground truth); still to pin: the **work machine's** gemini-cli + copilot (versions/paths may
   differ). Record verified ground truth per agent; pin versions.
2. **✓ DONE — `@trove/core`:** normalized model + medium-neutral adapter interface + **Claude Code
   adapter** as reference; ingestion + slim-canonical archive (optional gz raw) + SQLite store with
   message-level FTS5 from the start (WAL + `busy_timeout`). Core is framework-free / zero-dep;
   **Drizzle deferred to the @trove/api layer** (bun:sqlite direct for now).
3. **✓ DONE — `@trove/cli`** (commander, direct `core` calls, no HTTP): `sync` / `list`.
4. **✓ DONE (mostly) — Search:** `search` (keyword, `--exact`, `--agent`/`--star`/`--tag`/`--project`,
   dates, `--group-by-session`/`--messages`, `--json`) + `status` + `show`, with cooldown-gated JIT
   sync. **Still to add: `pick` (fzf) and `--here`.**
5. **✓ DONE — Metadata** (name / star / tag / note / hide) in core, in a sidecar table (survives
   re-sync, verified) and wired into search/list filters.
6. Add the **gemini-cli adapter** (the work target; then copilot, then agy) — no changes above the
   adapter layer. First non-file (SQLite) adapter stress-tests the medium-neutral contract.
7. Background auto-index + post-session hook; `context` / `tree`.
8. **✓ DONE — `@trove/api` (thin tRPC v11 router) + `@trove/web`:** Bun-native fullstack (no Vite;
   server folded into web), React + TanStack Query + tRPC client. List (agent badge/filter) + live
   FTS search with highlighting + detail view (render, star/rename/tag/notes, resume). Localhost-only
   bind + cross-site request guard. Verified in-browser against real data (111 sessions, 2 agents).
9. Optional: resume, export, Claude Code skill packaging, insight extraction.
