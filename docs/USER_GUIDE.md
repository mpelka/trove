# trove — user guide

trove is a **local, read-only** browser + search engine for your CLI coding-agent sessions
(Claude Code, gemini-cli, Copilot CLI, Antigravity). It reads your existing session files in
place, keeps a slim searchable archive, and never phones home. Everything runs on your
machine; the only network calls that ever happen are ones **you** configure (the optional
ghostwriter summarizer).

---

## 1. Requirements

- [Bun](https://bun.sh) (the only runtime dependency). Check with `bun --version`.
- Your agent session stores in their default locations (see step 3).

## 2. Install

```sh
git clone https://github.com/mpelka/trove.git
cd trove
bun install
```

That's it — there's no build step.

## 3. Index your sessions

trove **discovers your existing CLI sessions automatically** — there is no separate "import"
step for Claude Code, gemini-cli, Copilot, or Antigravity. It reads them from their standard
on-disk locations. Run:

```sh
bun run trove sync      # discover + index everything (safe to re-run anytime)
bun run trove status    # see the per-agent counts
```

`status` should show a line per agent, e.g.:

```
  · gemini-cli   16 sessions · 358 messages
  · copilot      13 sessions · 26 messages
```

If an agent you use shows **0 sessions**, its store isn't where trove looks by default —
tell me the path and we'll point the adapter at it.

### Importing webapp exports (ChatGPT + claude.ai)

Sessions from the **ChatGPT** and **claude.ai** web apps are imported from their official data
exports:

1. Request an export:
   - **ChatGPT**: Settings → Data controls → Export data.
   - **claude.ai**: Settings → Privacy → Export data.
   You'll get a `.zip` by email in each case.
2. Unzip it into **`~/.trove/imports/`** (any subfolder, e.g. `~/.trove/imports/chatgpt/` or
   `~/.trove/imports/claude/`).
3. Run `bun run trove sync`.

They show up as their own agents — **`chatgpt`** and **`claude-web`** (chip labelled "claude.ai",
distinct from "claude" which is Claude Code). Re-exporting later and re-syncing updates changed
conversations and adds new ones. Empty/contentless conversations are skipped; image and file
attachments are imported as text references (`[image: name.png]`, `[attachment: name]`), never the
binaries. It all runs locally — nothing is uploaded.

## 4. The GUI

```sh
bun run gui
```

Opens a local server at **http://localhost:4319** (localhost-only — never exposed on the
network). What you can do:

- **Search** — the box at the top is full-text keyword search across every session (offline,
  instant). Filter chips: agent (claude/gemini/copilot/agy), ⭐ starred, highlights.
- **Read** — click a session; the middle pane is the conversation. Tool calls are collapsed
  into a group — **click a tool group to expand** it and see the actual command (e.g. the Bash
  line that ran).
- **Highlight** — select any text in a message (drag *or* triple-click a paragraph) and click
  the **Highlight** button that pops up. Saved highlights are marked in the text and listed in
  the info panel. **Click a highlight** (in the body or the panel) to remove it (with a confirm).
- **Info panel** — the toggle at the top-right of a conversation opens a right-hand panel with
  the session's metadata, its ghostwriter summary, and its highlights (click one to jump to it).
- **Reader settings** — the ☰ flyout (top-left) sets conversation width and line-spacing.
- **Star / rename / delete / resume** — the icon row above a conversation. "Resume" copies the
  exact command to continue that session in its original agent.

## 5. Ghostwriter (optional AI summaries)

trove itself makes **no** network calls. Summaries are produced by piping a session's text
through a shell command **you** configure in `~/.trove/config.json`:

```json
{
  "summarizer": "gemini -m gemini-2.5-flash -p 'Summarize this coding-agent conversation from its transcript below. Cover the goal, key decisions, and any gotchas. Be concise. Output Markdown.'"
}
```

The command must **read the transcript on stdin** and **write the summary to stdout**. Any
CLI that does that works (`gemini …`, `agy --model '…' -p '…'`, a local LLM, etc.). Then click
the ✨ on any conversation. If the command fails (e.g. auth), trove shows a tidy error with the
details tucked behind a toggle — it never blocks.

> This config file is **per-machine** and not part of the source, so each machine (home vs.
> work) keeps its own summarizer.

## 6. CLI cheat-sheet

Everything the GUI does is also on the CLI (`bun run trove <command> --help` for details):

| Command | What it does |
|---|---|
| `sync` | Discover + index new/changed sessions |
| `sync --force` | Re-index **everything** (use after upgrading trove — see §7) |
| `search <words>` | Keyword search (`--agent`, `--project`, `--here`, `--since`, `--json`) |
| `list` | List sessions (filters + sort) |
| `status` | Store stats + per-agent counts |
| `show <id>` | Print a session |
| `tree <id>` | Show a session's context/branch tree |
| `export <id>` | Export a session (e.g. Markdown) |
| `summarize <id>` | Run the ghostwriter from the terminal |
| `highlights` | List your saved highlights |
| `star` / `name` / `tag` / `note` / `hide` / `delete` | Curate a session |

Short ids shown in the GUI/CLI (e.g. `cc:7de4…`, `agy:1bc8…`) are accepted anywhere an id is.

## 7. Upgrading trove

```sh
git pull
bun install
bun run trove status     # opening the store auto-applies any schema migrations
```

`status` prints the version you're on (e.g. `v0.2.0 (2011875)`), so you can check that two
machines actually match — `bun run trove --version` reports the same.

Schema changes are handled by tracked migrations that run automatically — your existing
`~/.trove/trove.db` is upgraded in place, nothing is lost. If a release changes **how sessions
are parsed** (e.g. a new detail like captured tool commands), backfill it across your history
with:

```sh
bun run trove sync --force
```

## 8. Where your data lives

- `~/.trove/trove.db` — the archive + search index (SQLite).
- `~/.trove/config.json` — your settings (summarizer).
- `~/.trove/archive/` — optional gzipped raw copies (only if you sync with `--keep-raw`).

Your original agent session files are **never modified** (the one exception: `delete
--delete-source`, which you opt into explicitly). Deleting a session in trove tombstones it so
sync won't re-add it.
