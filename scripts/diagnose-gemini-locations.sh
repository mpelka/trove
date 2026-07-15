#!/usr/bin/env bash
# Map WHERE gemini-cli keeps sessions on this machine, and which of them trove's
# adapter glob (`*/chats/session-*.{json,jsonl}`) actually reaches.
#
# Background (verified in the published 0.44.1 bundle): every project gets a flat
# slug dir — slugify(basename(cwd)), registered in ~/.gemini/projects.json — and
# chats live at ~/.gemini/tmp/<slug>/chats/session-*.jsonl. Subagent transcripts
# nest one level deeper (chats/<parentSessionId>/…) and are skipped on purpose.
# ~/.gemini/history/<slug>/ exists too but should hold shell history, not chats.
# This script verifies all of that against reality — for the case where sessions
# started inside a repo (cwd = ~/projects/some-repo) seem to vanish from trove.
#
# CONTENT-SAFE: prints directory names, project paths and counts — never message text.
# Run:  bash scripts/diagnose-gemini-locations.sh
set -uo pipefail

GEM="${HOME}/.gemini"
if [ ! -d "$GEM" ]; then echo "no ~/.gemini"; exit 0; fi

echo "== registry (~/.gemini/projects.json): project path -> slug =="
if [ -f "$GEM/projects.json" ]; then
  bun -e '
const d = JSON.parse(require("fs").readFileSync(process.env.HOME + "/.gemini/projects.json", "utf8"));
for (const [p, slug] of Object.entries(d.projects ?? {})) console.log(`  ${slug}  <-  ${p}`);
' 2>/dev/null || echo "  (unreadable)"
else
  echo "  (missing — pre-slug gemini, hash dirs only)"
fi

profile() { # $1 = root dir to profile
  local root="$1"
  [ -d "$root" ] || { echo "  (no such dir)"; return; }
  local dir name owner top nested loose
  for dir in "$root"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    owner="-"
    [ -f "$dir/.project_root" ] && owner=$(head -c 200 "$dir/.project_root" | tr -d '\n')
    # top = what trove's glob sees; nested = subagent transcripts (skipped by design);
    # loose = session files OUTSIDE any chats/ dir (would be a new storage layout).
    top=$(find "$dir/chats" -maxdepth 1 -name 'session-*.json*' 2>/dev/null | wc -l | tr -d ' ')
    nested=$(find "$dir/chats" -mindepth 2 -name 'session-*.json*' 2>/dev/null | wc -l | tr -d ' ')
    loose=$(find "$dir" -name 'session-*.json*' -not -path '*/chats/*' 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-30s chats:%-4s subagent:%-4s loose:%-4s root:%s\n' "$name" "$top" "$nested" "$loose" "$owner"
  done
}

echo
echo "== ~/.gemini/tmp (trove reads THIS, one slug dir per project) =="
profile "$GEM/tmp"

echo
echo "== ~/.gemini/history (should be shell history, NOT chats — verify) =="
profile "$GEM/history"

echo
echo "== totals =="
ALL=$(find "$GEM" -name 'session-*.json*' 2>/dev/null | wc -l | tr -d ' ')
SEEN=$(find "$GEM/tmp" -mindepth 3 -maxdepth 3 -path '*/chats/session-*.json*' 2>/dev/null | wc -l | tr -d ' ')
echo "  session files anywhere under ~/.gemini : $ALL"
echo "  reachable by trove's glob              : $SEEN"
echo "  (a gap here = sessions living somewhere the adapter does not look)"
