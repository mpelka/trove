# trove

*A local, read-only librarian, search engine, and archive for your CLI coding-agent sessions.*

Find that conversation you half-remember — search the full text of every session across your
agents, then read it or resume it. trove **archives the meat on ingest**, so your sessions survive
each agent's retention cleanup and outlive deleted worktrees. See [trove-plan.md](trove-plan.md)
for the full design.

## Status

Milestone 1 (this build): **`@trove/core` + `@trove/cli`**, keyword search over the **Claude Code**
adapter, working end-to-end on real data. On a real machine: 450 MB of raw sessions → a ~32 MB
index (~14×), 93 sessions / ~40k messages synced in ~3 s.

Next: gemini-cli adapter (ground truth already pinned), then copilot / antigravity; `context`/`tree`;
the tRPC/web layer. Semantic search is deliberately deferred (keyword-only, zero network).

## Quick start

```sh
bun install
alias trove="bun run $(pwd)/packages/cli/src/index.ts"   # or add packages/cli/src/index.ts to PATH

trove sync                 # discover, slim-archive, and index all sessions
trove search gemini flag   # full-text search, grouped by session
trove status               # index health
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
| `trove name / star / tag / note / hide <id>` | User-owned metadata — kept in a sidecar table, never clobbered by re-sync. |

## Design (as built)

- **Slim canonical, latest-wins.** The adapter keeps user + assistant text (incl. code blocks) and
  drops thinking, tool-result bodies, and images — that's ~90 % of the bytes in a coding session.
- **One file = one session.** Claude Code's identity is the `.jsonl` filename; the in-content
  `sessionId` is shared across resumes/subagents, so subagent transcripts
  (`<session>/subagents/agent-*.jsonl`) are filtered as noise.
- **Sidecar metadata** (names, stars, tags, notes) lives in its own table — re-imports never touch it.
- **No daemon.** Freshness comes from a cooldown-gated JIT sync before search plus (future)
  per-agent post-session hooks. Nothing runs in the background.
- **`@trove/core` is framework-free** (`bun:sqlite`, zero deps). The tRPC/Drizzle layer arrives with
  the web GUI, not before.

## Layout

```
packages/core   adapters · ingest/slim-extract · SQLite+FTS5 store · search · metadata
packages/cli    commander CLI over core (direct calls, no HTTP)
```
