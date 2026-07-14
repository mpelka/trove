#!/usr/bin/env bash
# Profile the .jsonl gemini session format (gemini-cli 0.44.x).
# CONTENT-SAFE: prints line counts and JSON key NAMES only — never message text.
# Deliberately terse: ~10 lines, so it's easy to screenshot.
#
# Run:  bash scripts/diagnose-gemini-jsonl.sh
set -uo pipefail

F="$(find "$HOME/.gemini/tmp" -type f -name 'session-*.jsonl' -path '*/chats/*' -size +2k 2>/dev/null | head -1)"
[ -z "$F" ] && F="$(find "$HOME/.gemini/tmp" -type f -name '*.jsonl' -path '*/chats/*' -size +2k 2>/dev/null | head -1)"
if [ -z "$F" ]; then echo "no .jsonl found under ~/.gemini/tmp/*/chats/"; exit 0; fi

echo "file:  $(echo "$F" | sed "s|$HOME/.gemini/||")"
echo "bytes: $(wc -c < "$F" | tr -d ' ')   lines: $(wc -l < "$F" | tr -d ' ')"

TROVE_F="$F" bun -e '
const fs = require("fs");
const raw = fs.readFileSync(process.env.TROVE_F, "utf8");
const lines = raw.split("\n").filter(l => l.trim());
let bad = 0; const keys = new Set(), types = new Set(), contentT = new Set();
let firstKeys = null, lastKeys = null;
for (const [i, l] of lines.entries()) {
  let o; try { o = JSON.parse(l); } catch { bad++; continue; }
  if (!o || typeof o !== "object") continue;
  const k = Object.keys(o);
  if (firstKeys === null) firstKeys = k.join(", ");
  lastKeys = k.join(", ");
  k.forEach(x => keys.add(x));
  if (typeof o.type === "string") types.add(o.type);
  if (typeof o.role === "string") types.add("role:" + o.role);
  if ("content" in o) contentT.add(Array.isArray(o.content) ? "array" : typeof o.content);
}
console.log("valid JSON lines:", lines.length - bad, "| unparseable:", bad);
console.log("FIRST line keys:", firstKeys);          // is line 1 a session header, or a message?
console.log("LAST  line keys:", lastKeys);
console.log("union of keys  :", [...keys].join(", "));
console.log("type/role values:", [...types].join(", ") || "(none)");
console.log("typeof content :", [...contentT].join(", ") || "(no content key)");
'
