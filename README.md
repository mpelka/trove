# trove

*A local, read-only librarian, search engine, and archive for your CLI coding-agent sessions.*

Find that conversation you half-remember — search the full text of every session across your
agents, then read it or resume it. trove **archives the meat on ingest**, so your sessions survive
each agent's retention cleanup and outlive deleted worktrees. Design rationale + verified
ground-truth notes live in [docs/trove-plan.md](docs/trove-plan.md) (archived); the live roadmap is
in [GitHub issues](https://github.com/mpelka/trove/issues).

## Status

**v0.1 — full stack working end-to-end on real data:**
- **Adapters (4):** Claude Code (JSONL), gemini-cli (per-session JSON), Copilot (shared SQLite DB),
  antigravity (per-conversation SQLite, protobuf steps) — the last two prove the medium-neutral
  adapter contract (files *or* databases) with zero changes above the adapter layer.
- **CLI:** sync / search / list / status / show / delete + metadata (name, star, tag, hide).
- **GUI:** localhost web app (React 19 + [Kumo](https://github.com/cloudflare/kumo) + tRPC,
  Bun-native bundling) — live full-text search with in-body highlighting, search-by-id jump,
  URL-synced state, markdown rendering, collapsed tool chains, user chat bubbles, rename/star,
  delete with tombstones, light/dark.
- Real-machine numbers: 450 MB of raw sessions → ~32 MB index (~14×); ~110 sessions / ~40k
  messages synced in ~3 s.

Semantic search is deliberately deferred — keyword-only, zero network, zero model download
([#11](https://github.com/mpelka/trove/issues/11)).

## Quick start

```sh
bun install
alias trove="bun run $(pwd)/packages/cli/src/index.ts"

trove sync                 # discover, slim-archive, and index all sessions
trove search gemini flag   # full-text search, grouped by session
trove status               # index health

bun run gui                # web GUI → http://localhost:4319 (localhost-only)
```

Data lives in `~/.trove/` (override with `TROVE_DIR`): `trove.db` (SQLite + FTS5) and `archive/`
(optional gzipped raw copies). Never committed — it may contain corporate code and secrets.

## Commands

| Command | What |
| --- | --- |
| `trove sync [--agent <id>] [--keep-raw]` | Incremental, idempotent ingest. `--keep-raw` also keeps a gzipped raw copy (resumable even after upstream deletion). |
| `trove search <query…>` | FTS5 keyword search. `--exact` phrase, `--messages` (vs grouped), `--agent`, `--star`, `--project`, `--tag`, `--since/--until/--days`, `--json`. Runs a cooldown-gated JIT sync first (`--no-sync` to skip). |
| `trove list` | Browse sessions. `--agent --star --project --tag --sort --limit --all --json`. |
| `trove status` | Counts per agent, last sync, DB size. |
| `trove show <id>` | Render an archived session (id or prefix); prints the resume command. |
| `trove context <msg> [-n depth]` | Messages around a hit (walks parent links where the agent has them). |
| `trove tree <id>` | A session's branch structure; flat list for agents without parent links. |
| `trove export <id> [--md\|--json] [-o file]` | Export a session for an external knowledge base. |
| `trove delete <id> [--source] [-y]` | Remove from trove (tombstoned — sync won't re-add). `--source` also deletes the original file. |
| `trove name / star / tag / note / hide <id>` | User-owned metadata — kept in a sidecar table, never clobbered by re-sync. |
| `trove hook` | Print a post-session reindex hook config to apply yourself. |

`search` and `list` also take `--here` (scope to the current git repo). Ids are accepted in any
form trove prints them: full (`claude-code:<uuid>`), short (`cc·7de43815`), or a unique prefix.

## Testing

```sh
bun test        # colocated *.test.ts next to the code they test
```

## Design (as built)

- **Slim canonical, latest-wins.** Adapters keep user + assistant text (incl. code blocks) and drop
  thinking, tool-result bodies, and images — that's ~90 % of the bytes in a coding session. Tool
  calls survive as compact `[used: 2×Bash, Read]` markers.
- **One file = one session.** Identity is the filename stem, never the in-content session id (which
  Claude Code shares across resumes/subagents); subagent transcripts are filtered as noise, and so
  are harness-injected pseudo-user turns (task notifications, system reminders, command wrappers).
- **Sidecar metadata** (names, stars, tags, notes) lives in its own table — re-imports never touch
  it. Deletes are **tombstoned** so a sync never resurrects a curated-away session.
- **No daemon.** Freshness comes from a cooldown-gated JIT sync before search plus (future)
  per-agent post-session hooks ([#5](https://github.com/mpelka/trove/issues/5)).
- **`@trove/core` is framework-free** (`bun:sqlite`, zero deps); `@trove/api` is a thin tRPC layer;
  the GUI server binds localhost only and rejects cross-site requests.

## Layout

```
packages/core   adapters · ingest/slim-extract · SQLite+FTS5 store · search · metadata · curation
packages/api    thin tRPC v11 router over core (zod-validated)
packages/cli    commander CLI over core (direct calls, no HTTP)
packages/web    Bun-native fullstack GUI (React 19 + Kumo + Tailwind v4 + tRPC client)
docs/           archived design doc (ground truth, rationale)
```
