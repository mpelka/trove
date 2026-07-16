#!/usr/bin/env bash
# Replay gemini .jsonl mutation logs the way trove's adapter does, and report
# every event that REMOVES or EMPTIES a message — for the "responses show in raw
# view but not in the reader" case: the file provably holds the text, so some
# later record (empty-content re-push, $rewindTo, or a mid-file $set.messages
# reseed) must be eating it during replay. Names the record, by line number.
#
# CONTENT-SAFE: prints ids, line numbers, types, text LENGTHS and key names only.
#
# One file (full event log):
#   bash scripts/diagnose-gemini-replay.sh ~/.gemini/tmp/<slug>/chats/session-....jsonl
# Scan a whole store (one summary line per session; find the affected files):
#   bash scripts/diagnose-gemini-replay.sh ~/.gemini/tmp
set -uo pipefail
TARGET="${1:-}"
if [ -z "$TARGET" ]; then echo "usage: $0 <session .jsonl | store dir>"; exit 1; fi

JS='
const fs = require("fs");
const file = process.env.RFILE;
const summary = !!process.env.SUMMARY;
const lines = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim());

// text length of a record, mirroring what the adapter would extract
const tlen = (r) => {
  if (!r || typeof r !== "object") return 0;
  if (typeof r.content === "string") return r.content.length;
  if (Array.isArray(r.content))
    return r.content.reduce((n, p) => n + (p && typeof p.text === "string" ? p.text.length : 0), 0);
  return 0;
};

// Mirror of replaySessionLog (gemini-cli.ts): rewind / id-upsert / $set / header.
const messages = new Map(); // id -> record
const maxLen = new Map();   // id -> max text length ever seen
const events = [];
const counts = { header: 0, upsert: 0, setMeta: 0, reseed: 0, rewind: 0, bad: 0, other: 0 };

const seed = (arr, why, ln) => {
  let withText = 0;
  for (const m of arr) {
    if (m && typeof m === "object" && typeof m.id === "string") {
      messages.set(m.id, m);
      const L = tlen(m);
      if (L > (maxLen.get(m.id) ?? 0)) maxLen.set(m.id, L);
      if (L > 0) withText++;
    }
  }
  events.push(`line ${ln}: ${why} seeded ${arr.length} (${withText} with text)`);
};

lines.forEach((l, i) => {
  const ln = i + 1;
  let r; try { r = JSON.parse(l); } catch { counts.bad++; return; }
  if (!r || typeof r !== "object") { counts.bad++; return; }

  if (typeof r.$rewindTo === "string") {
    counts.rewind++;
    const ids = [...messages.keys()];
    const idx = ids.indexOf(r.$rewindTo);
    const doomed = idx === -1 ? ids : ids.slice(idx);
    const withText = doomed.filter(id => tlen(messages.get(id)) > 0).length;
    events.push(`line ${ln}: REWIND to ${r.$rewindTo.slice(0,8)} (target ${idx === -1 ? "NOT FOUND — clears all" : "found"}) deletes ${doomed.length} msgs, ${withText} with text`);
    if (idx === -1) messages.clear(); else for (const id of doomed) messages.delete(id);
  } else if (typeof r.id === "string") {
    counts.upsert++;
    const prev = messages.get(r.id);
    const prevMax = maxLen.get(r.id) ?? 0;
    const L = tlen(r);
    if (L > prevMax) maxLen.set(r.id, L);
    if (prev && prevMax > 0 && L === 0) {
      events.push(`line ${ln}: CLOBBER ${r.id.slice(0,8)} text ${prevMax} -> 0  (type:${r.type}, keys: ${Object.keys(r).join(",")})`);
    }
    messages.set(r.id, r);
  } else if (r.$set && typeof r.$set === "object") {
    if (Array.isArray(r.$set.messages)) {
      counts.reseed++;
      const hadText = [...messages.values()].filter(m => tlen(m) > 0).length;
      events.push(`line ${ln}: RESEED clears ${messages.size} accumulated (${hadText} with text) then:`);
      messages.clear();
      seed(r.$set.messages, "RESEED", ln);
    } else counts.setMeta++;
  } else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") {
    counts.header++;
    if (Array.isArray(r.messages)) seed(r.messages, "header", ln);
  } else counts.other++;
});

const legacy = counts.bad > lines.length * 0.9;
const eaten = [...maxLen.entries()].filter(([id, mx]) => mx > 0 && tlen(messages.get(id)) === 0);
const destructive = events.filter(e => /CLOBBER|REWIND|RESEED/.test(e)).length;

if (summary) {
  const name = file.split("/").slice(-1)[0];
  if (legacy) console.log(`  legacy .json-style — skipped              ${name}`);
  else console.log(`  eaten:${String(eaten.length).padStart(3)}  events:${String(destructive).padStart(3)}  msgs:${String(messages.size).padStart(4)}  ${name}${eaten.length > 0 ? "  <<<" : ""}`);
  process.exit(0);
}

console.log(`records: ${lines.length}`);
console.log(`branches: ${JSON.stringify(counts)}`);
if (legacy) {
  console.log("\nnearly every line failed to parse as a JSON record — this looks like a");
  console.log("pretty-printed legacy .json, not a .jsonl mutation log. Point me at the .jsonl.");
  process.exit(0);
}

console.log("\n== destructive events (this is the list that matters) ==");
const shown = events.filter(e => /CLOBBER|REWIND|RESEED/.test(e));
if (shown.length === 0) console.log("  none — replay loses nothing; the eater is elsewhere");
for (const e of shown.slice(0, 30)) console.log("  " + e);
if (shown.length > 30) console.log(`  …+${shown.length - 30} more`);

console.log(`\n== ids that HAD text but ended empty/deleted: ${eaten.length} ==`);
for (const [id, mx] of eaten.slice(0, 15))
  console.log(`  ${id.slice(0, 8)}  max ${mx} chars  final ${messages.has(id) ? "EMPTIED" : "DELETED"}`);

const seq = [...messages.values()].map(m => `${m.type ?? "?"}:${tlen(m)}`);
console.log(`\nfinal replayed sequence (${seq.length} msgs): ${seq.slice(0, 50).join(" ")}${seq.length > 50 ? " …" : ""}`);
'

if [ -d "$TARGET" ]; then
  # Scan mode: one line per top-level session .jsonl (the same files trove's glob
  # reaches — subagent transcripts nested under chats/<id>/ are excluded).
  echo "== scanning $TARGET =="
  find "$TARGET" -path '*/chats/session-*.jsonl' -not -path '*/chats/*/*' 2>/dev/null | sort | while read -r f; do
    RFILE="$f" SUMMARY=1 bun -e "$JS" || echo "  (failed to read) $f"
  done
  echo "(rows marked <<< lose messages in replay — rerun on that single file for the full event log)"
  exit 0
fi

if [ ! -f "$TARGET" ]; then
  echo "no such file: $TARGET"
  D=$(dirname "$TARGET")
  if [ -d "$D" ]; then
    echo "closest names in $D:"
    ls "$D" 2>/dev/null | grep -i "$(basename "$TARGET" | cut -c1-18)" | head -5 | sed 's/^/  /'
  else
    echo "directory does not exist either: $D"
  fi
  exit 1
fi

RFILE="$TARGET" bun -e "$JS"
