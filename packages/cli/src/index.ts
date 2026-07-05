#!/usr/bin/env bun
import { Command } from "commander";
import {
  openContext,
  maybeSync,
  sync,
  searchMessages,
  searchSessions,
  listSessions,
  status,
  getSessionDetail,
  resolveSessionId,
  deleteSession,
  setName,
  setStar,
  setHidden,
  setNotes,
  addTags,
  removeTags,
  getAdapter,
  getContext,
  getTree,
  exportSession,
  listHighlights,
  lookupId,
  repoRoot,
  type TroveContext,
  type SyncResult,
  type TreeNode,
} from "@trove/core";
import { writeFileSync } from "node:fs";
import { c, fmtSize, fmtDate, fmtRelative, shortId, projectName } from "./format.ts";

const program = new Command();
program
  .name("trove")
  .description("A local librarian, search engine, and archive for your CLI coding-agent sessions.")
  .version("0.1.0");

import { parseDate } from "./dates.ts";

function printSyncResult(r: SyncResult): void {
  const parts = [
    `${c.green(`+${r.added}`)} new`,
    `${c.yellow(`~${r.updated}`)} updated`,
    `${r.unchanged} unchanged`,
    `${r.trivial} skipped`,
  ];
  if (r.gone) parts.push(c.dim(`${r.gone} gone`));
  console.error(c.dim("sync: ") + parts.join(c.dim(" · ")));
  for (const [agent, b] of Object.entries(r.perAgent)) {
    if (b.sessions) console.error(c.dim(`  ${agent}: ${b.sessions} sessions, ${b.messages} messages indexed`));
  }
}

function resolveOrExit(ctx: TroveContext, ref: string): string {
  const r = resolveSessionId(ctx.db, ref);
  if (r.kind === "ok") return r.id;
  if (r.kind === "none") {
    console.error(c.red(`No session matching "${ref}".`));
  } else {
    console.error(c.red(`Ambiguous "${ref}" — matches ${r.matches.length}:`));
    for (const m of r.matches) console.error("  " + shortId(m) + c.dim("  " + m));
  }
  ctx.close();
  process.exit(1);
}

// ── sync ────────────────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Discover, archive, and index new/changed sessions across all agents")
  .option("--agent <id>", "only this agent")
  .option("--keep-raw", "also keep a gzipped copy of the raw source (resumable safety net)")
  .option("--json", "output JSON")
  .action(async (opts) => {
    const ctx = openContext();
    try {
      const r = await sync(ctx.db, ctx.adapters, {
        agentIds: opts.agent ? [opts.agent] : undefined,
        keepRaw: !!opts.keepRaw,
        onProgress: opts.json ? undefined : (m) => console.error(c.dim(m)),
      });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else printSyncResult(r);
    } finally {
      ctx.close();
    }
  });

// ── search ──────────────────────────────────────────────────────────────────
program
  .command("search")
  .description("Full-text search across all archived sessions")
  .argument("<query...>", "keywords (or a phrase with --exact)")
  .option("--agent <id>", "filter by agent")
  .option("-n, --limit <n>", "max results", "20")
  .option("--exact", "phrase match")
  .option("--messages", "show individual message hits (default: group by session)")
  .option("--star", "only starred sessions")
  .option("--project <p>", "filter by origin project (substring)")
  .option("--here", "filter by the current repo (git root of cwd)")
  .option("--tag <t>", "filter by tag")
  .option("--since <date>", "on/after date (YYYY-MM-DD | today | yesterday)")
  .option("--until <date>", "on/before date")
  .option("--days <n>", "within the last N days")
  .option("--no-sync", "skip the cooldown-gated JIT sync")
  .option("--json", "output JSON")
  .action(async (queryParts: string[], opts) => {
    const ctx = openContext();
    try {
      if (opts.sync !== false) {
        const r = await maybeSync(ctx);
        if (r && !opts.json) printSyncResult(r);
      }
      const since = opts.days ? Date.now() - Number(opts.days) * 86400000 : parseDate(opts.since);
      const base = {
        query: queryParts.join(" "),
        agent: opts.agent,
        limit: Number(opts.limit) || 20,
        exact: !!opts.exact,
        star: !!opts.star,
        project: opts.here ? repoRoot() : opts.project,
        tag: opts.tag,
        since,
        until: parseDate(opts.until, { endOfDay: true }),
      };

      if (opts.messages) {
        const hits = searchMessages(ctx.db, base);
        if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
        if (!hits.length) return void console.log(c.dim("No matches."));
        for (const h of hits) {
          const gone = h.sourceGone ? c.red(" ⚠gone") : "";
          console.log(
            `${c.cyan(shortId(h.sessionId))} ${c.dim("#" + h.seq)} ${c.dim(h.role)} ${c.dim(fmtRelative(h.timestamp))}${gone}`,
          );
          console.log("  " + h.snippet.replace(/\s+/g, " ").trim());
        }
      } else {
        const hits = searchSessions(ctx.db, base);
        if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
        if (!hits.length) return void console.log(c.dim("No matches."));
        hits.forEach((h, i) => {
          const name = h.customName ?? h.title ?? "(untitled)";
          const gone = h.sourceGone ? c.red(" ⚠gone") : "";
          const star = h.starred ? c.yellow(" ★") : "";
          console.log(
            `${c.dim(String(i + 1).padStart(2))} ${c.bold(name)}${star}${gone} ${c.dim("·")} ${c.magenta(h.matchCount + "×")} ${c.dim("·")} ${projectName(h.projectPath)}`,
          );
          console.log(`   ${c.dim(shortId(h.sessionId) + "  " + fmtRelative(h.bestTimestamp))}`);
          console.log("   " + h.bestSnippet.replace(/\s+/g, " ").trim());
        });
      }
    } finally {
      ctx.close();
    }
  });

// ── list ────────────────────────────────────────────────────────────────────
program
  .command("list")
  .description("List archived sessions")
  .option("--agent <id>", "filter by agent")
  .option("--star", "only starred")
  .option("--project <p>", "filter by origin project (substring)")
  .option("--here", "filter by the current repo (git root of cwd)")
  .option("--tag <t>", "filter by tag")
  .option("--sort <s>", "updated | created | name | turns", "updated")
  .option("-n, --limit <n>", "max rows", "50")
  .option("--all", "include hidden")
  .option("--json", "output JSON")
  .action((opts) => {
    const ctx = openContext();
    try {
      const rows = listSessions(ctx.db, {
        agent: opts.agent,
        star: !!opts.star,
        project: opts.here ? repoRoot() : opts.project,
        tag: opts.tag,
        sort: opts.sort,
        limit: Number(opts.limit) || 50,
        includeHidden: !!opts.all,
      });
      if (opts.json) return void console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return void console.log(c.dim("No sessions. Run `trove sync`."));
      for (const r of rows) {
        const star = r.starred ? c.yellow("★") : " ";
        const gone = r.sourceGone ? c.red(" ⚠") : "";
        const tags = r.tags.length ? " " + c.blue(r.tags.map((t) => "#" + t).join(" ")) : "";
        console.log(
          `${star} ${c.bold(r.name.slice(0, 60).padEnd(60))} ${c.dim((r.turnCount ?? 0) + "t").padStart(5)} ${c.dim(fmtSize(r.sizeBytes).padStart(6))} ${c.dim(fmtRelative(r.updatedAt))}${gone}${tags}`,
        );
        console.log(`  ${c.dim(shortId(r.id))}  ${projectName(r.projectPath)}`);
      }
    } finally {
      ctx.close();
    }
  });

// ── status ──────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Index health and coverage")
  .option("--json", "output JSON")
  .action((opts) => {
    const ctx = openContext();
    try {
      const s = status(ctx.db);
      if (opts.json) return void console.log(JSON.stringify(s, null, 2));
      console.log(c.bold("trove status"));
      console.log(`  sessions:  ${c.cyan(s.totalSessions)}   messages: ${c.cyan(s.totalMessages)}`);
      console.log(`  starred:   ${s.starred}   gone: ${s.gone}   db: ${fmtSize(s.dbSizeBytes)}`);
      console.log(`  last sync: ${s.lastSync ? fmtRelative(s.lastSync) : c.dim("never")}`);
      for (const a of s.perAgent) {
        console.log(`  ${c.dim("·")} ${a.agent.padEnd(14)} ${a.sessions} sessions · ${a.messages} messages`);
      }
    } finally {
      ctx.close();
    }
  });

// ── show ────────────────────────────────────────────────────────────────────
program
  .command("show")
  .description("Render an archived session")
  .argument("<id>", "session id or prefix")
  .option("--json", "output JSON")
  .option("--limit <n>", "max messages to print", "200")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      const detail = getSessionDetail(ctx.db, id);
      if (!detail) return void console.error(c.red("not found"));
      if (opts.json) return void console.log(JSON.stringify(detail, null, 2));
      const s = detail.session;
      console.log(c.bold(s.name) + (s.starred ? c.yellow(" ★") : "") + (s.sourceGone ? c.red(" ⚠ source gone") : ""));
      console.log(c.dim(`  ${s.id}`));
      console.log(c.dim(`  ${projectName(s.projectPath)} · ${s.turnCount ?? 0} turns · ${s.messageCount ?? 0} msgs · ${s.model ?? "?"}`));
      console.log(c.dim(`  ${fmtDate(s.createdAt)} → ${fmtDate(s.updatedAt)}`));
      if (s.tags.length) console.log("  " + c.blue(s.tags.map((t) => "#" + t).join(" ")));
      if (s.notes) console.log("  " + c.dim("note: ") + s.notes);
      const adapter = getAdapter(s.agent);
      const resume = adapter?.buildResumeCommand?.({ nativeId: s.nativeId, projectPath: s.projectPath, rawPath: s.rawPath });
      if (resume) console.log(c.dim("  resume: ") + resume);
      console.log();
      const limit = Number(opts.limit) || 200;
      for (const m of detail.messages.slice(0, limit)) {
        const who = m.role === "user" ? c.green("▸ user") : m.role === "assistant" ? c.cyan("● assistant") : c.dim("· " + m.role);
        console.log(who + c.dim("  " + fmtRelative(m.timestamp)));
        console.log(m.text.length > 2000 ? m.text.slice(0, 2000) + c.dim(" …") : m.text);
        console.log();
      }
      if (detail.messages.length > limit) console.log(c.dim(`… ${detail.messages.length - limit} more (raise --limit)`));
    } finally {
      ctx.close();
    }
  });

// ── context ───────────────────────────────────────────────────────────────────
program
  .command("context")
  .description("Show a message with the messages surrounding it in its session")
  .argument("<messageId>", "message id (or a message uid / short id)")
  .option("-n, --depth <n>", "messages before/after", "3")
  .option("--json", "output JSON")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      // Accept a numeric rowid directly, or resolve a uid / short id to one.
      let messageId: number | null = /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
      if (messageId == null) {
        const hit = lookupId(ctx.db, ref);
        if (hit?.kind === "message" && hit.messageId != null) messageId = hit.messageId;
      }
      if (messageId == null) {
        console.error(c.red(`No message matching "${ref}".`));
        ctx.close();
        process.exit(1);
      }
      const result = getContext(ctx.db, messageId, Number(opts.depth) || 3);
      if (!result) return void console.error(c.red("not found"));
      if (opts.json) return void console.log(JSON.stringify(result, null, 2));
      const detail = getSessionDetail(ctx.db, result.sessionId);
      if (detail) {
        const s = detail.session;
        console.log(c.bold(s.name) + c.dim(`  ${shortId(s.id)}`));
        console.log(c.dim(`  ${projectName(s.projectPath)}`));
        console.log();
      }
      for (const m of result.messages) {
        const who =
          m.role === "user" ? c.green("▸ user")
          : m.role === "assistant" ? c.cyan("● assistant")
          : c.dim("· " + m.role);
        const marker = m.isTarget ? c.yellow(" ◀ #" + m.id) : c.dim(" #" + m.id);
        console.log(who + marker + c.dim("  " + fmtRelative(m.timestamp)));
        const body = m.text.length > 2000 ? m.text.slice(0, 2000) + c.dim(" …") : m.text;
        console.log(m.isTarget ? c.bold(body) : body);
        console.log();
      }
    } finally {
      ctx.close();
    }
  });

// ── tree ──────────────────────────────────────────────────────────────────────
program
  .command("tree")
  .description("Show a session's messages as a reply tree (parent_uid), or flat if unlinked")
  .argument("<id>", "session id or prefix")
  .option("--json", "output JSON")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      const tree = getTree(ctx.db, id);
      if (!tree) return void console.error(c.red("not found"));
      if (opts.json) return void console.log(JSON.stringify(tree, null, 2));
      const detail = getSessionDetail(ctx.db, id);
      if (detail) {
        console.log(c.bold(detail.session.name) + c.dim(`  ${shortId(id)}`));
        console.log(c.dim(`  ${tree.linked ? "linked tree" : "flat (no parent links)"}`));
        console.log();
      }
      const glyph = (role: string) =>
        role === "user" ? c.green("▸")
        : role === "assistant" ? c.cyan("●")
        : c.dim("·");
      const printNode = (n: TreeNode, indent: string) => {
        const line = n.text.replace(/\s+/g, " ").trim().slice(0, 80);
        console.log(`${indent}${glyph(n.role)} ${c.dim("#" + n.id)} ${line}`);
        for (const child of n.children) printNode(child, indent + "  ");
      };
      for (const root of tree.roots) printNode(root, "");
    } finally {
      ctx.close();
    }
  });

// ── export ────────────────────────────────────────────────────────────────────
program
  .command("export")
  .description("Export a session as markdown or JSON")
  .argument("<id>", "session id or prefix")
  .option("--md", "markdown (default)")
  .option("--json", "JSON")
  .option("-o, --out <file>", "write to a file instead of stdout")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      const format = opts.json ? "json" : "md";
      const rendered = exportSession(ctx.db, id, format);
      if (rendered == null) return void console.error(c.red("not found"));
      if (opts.out) {
        writeFileSync(opts.out, rendered);
        console.error(c.green("wrote ") + opts.out + c.dim(` (${format})`));
      } else {
        console.log(rendered);
      }
    } finally {
      ctx.close();
    }
  });

// ── highlights ──────────────────────────────────────────────────────────────
program
  .command("highlights")
  .description("List saved highlights — all, or for one session")
  .argument("[id]", "session id or prefix (omit for all)")
  .option("--json", "output JSON")
  .action((ref: string | undefined, opts) => {
    const ctx = openContext();
    try {
      const sessionId = ref ? resolveOrExit(ctx, ref) : undefined;
      const hits = listHighlights(ctx.db, { sessionId, limit: 500 });
      if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
      if (!hits.length) return void console.log(c.dim("No highlights."));
      for (const h of hits) {
        console.log(
          `${c.magenta("“" + h.text.replace(/\s+/g, " ").trim() + "”")}`,
        );
        if (h.note) console.log("  " + c.dim("— " + h.note));
        console.log(
          `  ${c.cyan(shortId(h.sessionId))} ${c.dim(h.sessionName)} ${c.dim(fmtRelative(h.createdAt))}`,
        );
      }
    } finally {
      ctx.close();
    }
  });

// ── metadata ──────────────────────────────────────────────────────────────────
program
  .command("name")
  .description("Give a session a custom name")
  .argument("<id>")
  .argument("<name...>")
  .action((ref: string, nameParts: string[]) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      setName(ctx.db, id, nameParts.join(" "));
      console.log(c.green("named ") + shortId(id) + " → " + nameParts.join(" "));
    } finally {
      ctx.close();
    }
  });

program
  .command("star")
  .description("Star (or --off to unstar) a session")
  .argument("<id>")
  .option("--off", "unstar")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      setStar(ctx.db, id, !opts.off);
      console.log((opts.off ? c.dim("unstarred ") : c.yellow("★ starred ")) + shortId(id));
    } finally {
      ctx.close();
    }
  });

program
  .command("tag")
  .description("Add (or --remove) tags on a session")
  .argument("<id>")
  .argument("<tags...>")
  .option("--remove", "remove instead of add")
  .action((ref: string, tags: string[], opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      const next = opts.remove ? removeTags(ctx.db, id, tags) : addTags(ctx.db, id, tags);
      console.log(c.blue("tags ") + shortId(id) + " → " + (next.length ? next.map((t) => "#" + t).join(" ") : c.dim("(none)")));
    } finally {
      ctx.close();
    }
  });

program
  .command("note")
  .description("Attach a note to a session")
  .argument("<id>")
  .argument("<note...>")
  .action((ref: string, noteParts: string[]) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      setNotes(ctx.db, id, noteParts.join(" "));
      console.log(c.green("noted ") + shortId(id));
    } finally {
      ctx.close();
    }
  });

program
  .command("hide")
  .description("Hide (or --off to unhide) a session from default lists")
  .argument("<id>")
  .option("--off", "unhide")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      setHidden(ctx.db, id, !opts.off);
      console.log((opts.off ? "unhid " : "hid ") + shortId(id));
    } finally {
      ctx.close();
    }
  });

program
  .command("hook")
  .description("Print agent hook config that reindexes trove when a session ends")
  .argument("[what]", "print", "print")
  .action(() => {
    const troveBin = `bun run ${new URL("./index.ts", import.meta.url).pathname}`;
    console.log(c.bold("Claude Code — add to ~/.claude/settings.json under \"hooks\":"));
    console.log(
      JSON.stringify(
        {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${troveBin} sync --agent claude-code >/dev/null 2>&1 &`,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    console.log();
    console.log(c.dim("Runs an incremental reindex in the background when a session ends."));
    console.log(c.dim("Verify the hook event name against your Claude Code version's docs."));
    console.log(c.dim("gemini-cli / copilot: no post-session hook mechanism pinned yet (issue #5)."));
  });

program
  .command("delete")
  .description("Delete a session from trove (tombstoned so sync won't re-add it)")
  .argument("<id>")
  .option("--source", "also delete the original session file (cannot be undone)")
  .option("-y, --yes", "skip confirmation")
  .action((ref: string, opts) => {
    const ctx = openContext();
    try {
      const id = resolveOrExit(ctx, ref);
      if (!opts.yes) {
        const ans = prompt(
          `Delete ${shortId(id)}${opts.source ? " AND its original file" : ""}? [y/N]`,
        );
        if ((ans ?? "").toLowerCase() !== "y") {
          console.log(c.dim("cancelled"));
          return;
        }
      }
      const r = deleteSession(ctx.db, id, { deleteSource: !!opts.source });
      console.log(
        r.ok
          ? c.green("deleted ") + shortId(id) + (r.sourceDeleted ? c.dim(" (source file removed)") : "")
          : c.red("not found"),
      );
    } finally {
      ctx.close();
    }
  });

program.parseAsync(process.argv);
