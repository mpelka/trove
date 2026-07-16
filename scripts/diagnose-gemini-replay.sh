#!/usr/bin/env bash
# Replay ONE gemini .jsonl mutation log the way trove's adapter does, and report
# every event that REMOVES or EMPTIES a message — for the "responses show in raw
# view but not in the reader" case: the file provably holds the text, so some
# later record (empty-content re-push, $rewindTo, or a mid-file $set.messages
# reseed) must be eating it during replay. This names the record, by line number.
#
# CONTENT-SAFE: prints ids, line numbers, types, text LENGTHS and key names only.
#
# Run:  bash scripts/diagnose-gemini-replay.sh ~/.gemini/tmp/<slug>/chats/session-....jsonl
set -uo pipefail
FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then echo "usage: $0 <session .jsonl>"; exit 1; fi

FILE="$FILE" bun -e '
const fs = require("fs");
const lines = fs.readFileSync(process.env.FILE, "utf8").split("\n").filter(l => l.trim());
console.log(`records: ${lines.length}`);

// text length of a record, mirroring what the adapter would extract
const tlen = (r) => {
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

console.log(`branches: ${JSON.stringify(counts)}`);
console.log("\n== destructive events (this is the list that matters) ==");
if (events.length === 0) console.log("  none — replay loses nothing; the eater is elsewhere");
for (const e of events.slice(0, 30)) console.log("  " + e);
if (events.length > 30) console.log(`  …+${events.length - 30} more`);

// verdict per id: text existed at some point but is gone/empty after full replay
const eaten = [...maxLen.entries()].filter(([id, mx]) => mx > 0 && tlen(messages.get(id) ?? {}) === 0);
console.log(`\n== ids that HAD text but ended empty/deleted: ${eaten.length} ==`);
for (const [id, mx] of eaten.slice(0, 15))
  console.log(`  ${id.slice(0, 8)}  max ${mx} chars  final ${messages.has(id) ? "EMPTIED" : "DELETED"}`);

// final replayed shape, lengths only
const seq = [...messages.values()].map(m => `${m.type ?? "?"}:${tlen(m)}`);
console.log(`\nfinal replayed sequence (${seq.length} msgs): ${seq.slice(0, 50).join(" ")}${seq.length > 50 ? " …" : ""}`);
'
