#!/usr/bin/env bash
# Profile the .jsonl gemini session format (gemini-cli 0.44.x).
#
# That format turned out to be an append-only MUTATION LOG, not one-message-per-line:
#   line 1 = session header {sessionId, projectHash, startTime, lastUpdated, kind}
#   line N = {$set: {...}}  — MongoDB-style update ops applied in order
# So this samples MANY files to learn the operator vocabulary and what the ops carry.
#
# CONTENT-SAFE: prints key names, counts and value TYPES only — never message text.
# Terse on purpose (~14 lines) so it's readable off a work screen.
#
# Run:  bash scripts/diagnose-gemini-jsonl.sh
set -uo pipefail

# Honours TROVE_GEMINI_ROOT, same as the adapter — which also lets this be tested
# against a fixture tree instead of a real store.
ROOT="${TROVE_GEMINI_ROOT:-$HOME/.gemini/tmp}"
if [ ! -d "$ROOT" ]; then echo "no such root: $ROOT"; exit 0; fi

find "$ROOT" -type f -name '*.jsonl' -path '*/chats/*' 2>/dev/null | head -25 > /tmp/_trove_jsonl_list
echo "sampling $(wc -l < /tmp/_trove_jsonl_list | tr -d ' ') of $(find "$ROOT" -type f -name '*.jsonl' -path '*/chats/*' 2>/dev/null | wc -l | tr -d ' ') .jsonl files"

bun -e '
const fs = require("fs");
const files = fs.readFileSync("/tmp/_trove_jsonl_list", "utf8").split("\n").filter(Boolean);
const topKeys = new Set(), setKeys = new Set(), msgKeys = new Set(), types = new Set(), contentT = new Set();
const lineCounts = []; let bad = 0, withMsgs = 0, totalMsgs = 0;

/** Find an array of message-ish objects anywhere shallow in a value. */
function harvest(v) {
  if (!Array.isArray(v)) return false;
  const objs = v.filter(x => x && typeof x === "object");
  if (!objs.length) return false;
  // message-ish = has a type/role, or a content/text field
  const looks = objs.some(o => "type" in o || "role" in o || "content" in o || "parts" in o);
  if (!looks) return false;
  for (const o of objs.slice(0, 20)) {
    Object.keys(o).forEach(k => msgKeys.add(k));
    if (typeof o.type === "string") types.add(o.type);
    if (typeof o.role === "string") types.add("role:" + o.role);
    if ("content" in o) contentT.add(Array.isArray(o.content) ? "array" : typeof o.content);
    if ("parts" in o) contentT.add("parts:" + (Array.isArray(o.parts) ? "array" : typeof o.parts));
  }
  totalMsgs += objs.length;
  return true;
}

for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, "utf8").split("\n").filter(l => l.trim()); } catch { continue; }
  lineCounts.push(lines.length);
  let fileHadMsgs = false;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { bad++; continue; }
    if (!o || typeof o !== "object") continue;
    Object.keys(o).forEach(k => topKeys.add(k));
    for (const [k, v] of Object.entries(o)) {
      // operator payloads ($set/$push/…): record their inner keys + look for messages
      if (k.startsWith("$") && v && typeof v === "object") {
        for (const [ik, iv] of Object.entries(v)) {
          setKeys.add(ik + ":" + (Array.isArray(iv) ? "array" : typeof iv));
          if (harvest(iv)) fileHadMsgs = true;
        }
      } else if (harvest(v)) fileHadMsgs = true;
    }
  }
  if (fileHadMsgs) withMsgs++;
}

const nums = lineCounts.sort((a, b) => a - b);
console.log("lines/file  : min", nums[0], "median", nums[Math.floor(nums.length / 2)], "max", nums[nums.length - 1]);
console.log("unparseable : ", bad);
console.log("TOP-LEVEL keys (the operator vocabulary):", [...topKeys].join(", "));
const sk = [...setKeys];
console.log("op payload keys (name:type):", sk.slice(0, 14).join(", ") + (sk.length > 14 ? `  …+${sk.length - 14} more` : ""));
console.log("files where I found messages:", withMsgs, "/", files.length, " | message objects seen:", totalMsgs);
console.log("MESSAGE keys:", [...msgKeys].join(", ") || "(none found — messages may live under a key I did not guess)");
console.log("type/role values:", [...types].join(", ") || "(none)");
console.log("typeof content:", [...contentT].join(", ") || "(none)");
'
rm -f /tmp/_trove_jsonl_list 2>/dev/null || true
