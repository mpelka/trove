#!/usr/bin/env bash
# Diagnose why the gemini-cli adapter finds no sessions on this machine.
#
# CONTENT-SAFE BY DESIGN: prints only paths, directory shapes, JSON *key names*,
# and counts — never message text, never JSON values (except the small enum-ish
# `type`/`kind` fields the adapter branches on). Safe to paste back.
#
# Run:  bash scripts/diagnose-gemini.sh
set -uo pipefail

echo "=== 1. gemini-cli version ==="
command -v gemini >/dev/null 2>&1 && gemini --version 2>&1 | head -3 || echo "(gemini not on PATH)"

echo
echo "=== 2. candidate store roots ==="
for d in "$HOME/.gemini" "$HOME/.config/gemini" "$HOME/.config/google-gemini" "$HOME/.cache/gemini"; do
  [ -e "$d" ] && echo "EXISTS: $d" || echo "absent: $d"
done

echo
echo "=== 3. what the adapter expects: \$HOME/.gemini/tmp ==="
if [ -d "$HOME/.gemini/tmp" ]; then
  echo "tmp/ exists. Immediate children (dirs):"
  find "$HOME/.gemini/tmp" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -5 | sed "s|$HOME|~|"
  echo "  ...total project dirs: $(find "$HOME/.gemini/tmp" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
else
  echo "!! $HOME/.gemini/tmp does NOT exist — this alone explains 0 sessions."
fi

echo
echo "=== 4. directory shape under ~/.gemini (depth 4, dirs only) ==="
# Basenames may be project names — redact freely, I only need the SHAPE/depth.
find "$HOME/.gemini" -maxdepth 4 -type d 2>/dev/null | sed "s|$HOME|~|" | head -25

echo
echo "=== 5. WHERE are the session JSONs? ==="
# Exclude config/plugins/skills — they're full of unrelated package.json/plugin.json noise
# that drowns out the signal (learned the hard way testing this locally).
NOISE=( -not -path '*/config/*' -not -path '*/node_modules/*' -not -path '*/skills/*' -not -path '*/plugins/*' )
echo "session-ish files (under a chats/ dir, or named session*/checkpoint*):"
find "$HOME/.gemini" -type f \( -path '*/chats/*' -o -name 'session*' -o -name 'checkpoint*' \) "${NOISE[@]}" 2>/dev/null \
  | head -12 | sed "s|$HOME/.gemini/||"
echo "  ...total: $(find "$HOME/.gemini" -type f \( -path '*/chats/*' -o -name 'session*' -o -name 'checkpoint*' \) "${NOISE[@]}" 2>/dev/null | wc -l | tr -d ' ')"
echo "other non-config *.json (in case the layout is different entirely):"
find "$HOME/.gemini" -name '*.json' -type f "${NOISE[@]}" 2>/dev/null | head -8 | sed "s|$HOME/.gemini/||"

echo
echo "=== 6. does the adapter's exact glob match anything? ==="
echo "  \$HOME/.gemini/tmp/*/chats/session-*.json  ->  $(ls "$HOME"/.gemini/tmp/*/chats/session-*.json 2>/dev/null | wc -l | tr -d ' ') file(s)"
echo "  \$HOME/.gemini/tmp/*/chats/*.json          ->  $(ls "$HOME"/.gemini/tmp/*/chats/*.json 2>/dev/null | wc -l | tr -d ' ') file(s)"

echo
echo "=== 7. shape of ONE session file (KEY NAMES ONLY, no values) ==="
# Pick an actual session file, not a stray package.json from a bundled skill.
CAND="$(find "$HOME/.gemini" -type f -name '*.json' \( -path '*/chats/*' -o -name 'session*' -o -name 'checkpoint*' \) \
  -not -path '*/config/*' -not -path '*/node_modules/*' -not -path '*/skills/*' -not -path '*/plugins/*' 2>/dev/null | head -1)"
if [ -z "$CAND" ]; then
  echo "(no candidate json found)"
elif ! command -v bun >/dev/null 2>&1; then
  echo "(bun not on PATH; skipping)"
else
  echo "file: $(echo "$CAND" | sed "s|$HOME/.gemini/||")"
  TROVE_DIAG_FILE="$CAND" bun -e '
    const fs = require("fs");
    try {
      const r = JSON.parse(fs.readFileSync(process.env.TROVE_DIAG_FILE, "utf8"));
      console.log("  top-level keys:", Object.keys(r).join(", "));
      const msgs = r.messages ?? r.history ?? r.turns ?? r.chat ?? null;
      if (Array.isArray(msgs)) {
        console.log("  messages array key:", r.messages ? "messages" : r.history ? "history" : r.turns ? "turns" : "chat");
        console.log("  message count:", msgs.length);
        const keys = new Set(); const types = new Set();
        for (const m of msgs.slice(0, 40)) {
          if (m && typeof m === "object") {
            Object.keys(m).forEach(k => keys.add(k));
            if (typeof m.type === "string") types.add(m.type);
            if (typeof m.role === "string") types.add("role:" + m.role);
          }
        }
        console.log("  message keys:", [...keys].join(", "));
        console.log("  distinct type/role values:", [...types].join(", ") || "(none)");
        const first = msgs.find(m => m && typeof m === "object");
        console.log("  typeof content of first msg:", first ? (Array.isArray(first.content) ? "array" : typeof first.content) : "n/a");
      } else {
        console.log("  !! no recognised messages array; top-level value types:",
          Object.entries(r).map(([k,v]) => k + ":" + (Array.isArray(v) ? "array" : typeof v)).join(", "));
      }
    } catch (e) { console.log("  parse failed:", e.message); }
  '
fi

echo
echo "=== 8. .project_root sibling present? (adapter uses it for project path) ==="
echo "count: $(find "$HOME/.gemini" -name '.project_root' 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "=== done — paths/keys only; redact any project names before pasting ==="
