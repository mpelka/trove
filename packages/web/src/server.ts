import index from "./index.html";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@trove/api";
import { openContext, maybeSync } from "@trove/core";

// One DB owner for the GUI process (the CLI opens its own when the server is down).
const trove = openContext();
const port = Number(process.env.TROVE_PORT ?? 4319);

// Background freshness, GUI-lifetime only (no daemon: this loop exists solely while
// the server is open). maybeSync is TTL-gated, so ticks are no-ops unless stale.
const SYNC_TICK_MS = Number(process.env.TROVE_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
setInterval(() => {
  maybeSync(trove, SYNC_TICK_MS)
    .then((r) => {
      if (r && (r.added || r.updated)) {
        console.log(`resync: +${r.added} new, ~${r.updated} updated`);
      }
    })
    .catch((err) => console.error("resync failed:", err));
}, SYNC_TICK_MS);

const server = Bun.serve({
  port,
  // Localhost only — sessions may contain corporate code/secrets; never expose on the LAN.
  hostname: process.env.TROVE_HOST ?? "localhost",
  development: process.env.NODE_ENV === "production" ? false : { hmr: true },
  routes: {
    "/api/trpc/*": (req) => {
      // Defense-in-depth: block cross-site browser requests (a malicious page firing writes
      // at localhost). Same-origin requests, direct navigations, and non-browser clients pass.
      const site = req.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") {
        return new Response("forbidden", { status: 403 });
      }
      return fetchRequestHandler({
        endpoint: "/api/trpc",
        req,
        router: appRouter,
        createContext: () => ({ trove }),
      });
    },
    "/*": index,
  },
});

console.log(`trove GUI → http://localhost:${server.port}`);
