/**
 * Compile every route in the background, once, at dev-server start.
 *
 * On-demand compilation is what makes a Next dev server feel slow: the first
 * click on any page pays for its build, and the person reading that pause blames
 * the application rather than the compiler. Requesting the routes ourselves
 * moves that cost to startup, where nobody is waiting on it.
 *
 * A PAGE IS NOT ENOUGH. Compiling /knowledge does not compile the API routes it
 * fetches from, so the page paints instantly and then sits empty for twenty
 * seconds while /api/knowledge/documents builds. Both halves have to be warmed
 * or the wait just moves somewhere less obvious.
 *
 * Routes are DISCOVERED from the filesystem rather than listed here, because a
 * hardcoded list is a list that goes stale the first time someone adds a page
 * and forgets this file.
 */

import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const BASE = process.env.WARM_BASE_URL || "http://localhost:3000";
const APP_DIR = "src/app";

/** A value for [id] segments. Auth runs before any lookup, so it is never used. */
const PLACEHOLDER = "warmup";

/** Warming means GET only. Anything that could change data is never called. */
const SAFE_METHOD = "GET";

function discover(dir, segments = []) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Route groups — (dashboard) — and private folders — _lib — are not URL
      // segments. Parallel/intercepting routes are skipped: requesting one on
      // its own is not meaningful.
      if (entry.startsWith("@") || entry.startsWith("_")) continue;
      const isGroup = entry.startsWith("(") && entry.endsWith(")");
      found.push(...discover(full, isGroup ? segments : [...segments, entry]));
      continue;
    }

    if (entry === "page.tsx" || entry === "page.ts" || entry === "page.jsx") {
      found.push({ kind: "page", path: toUrl(segments) });
    } else if (entry === "route.ts" || entry === "route.js") {
      found.push({ kind: "api", path: toUrl(segments) });
    }
  }
  return found;
}

function toUrl(segments) {
  const parts = segments.map((s) => {
    // [id] and [...slug] both become one placeholder segment.
    if (s.startsWith("[") && s.endsWith("]")) return PLACEHOLDER;
    return s;
  });
  return "/" + parts.join("/");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(BASE, { method: "HEAD" });
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

async function main() {
  const routes = discover(APP_DIR.split("/").join(sep));

  // Pages first — that is what someone clicks — then the endpoints behind them.
  // Within each group, deeper paths last: the shallow ones are visited first.
  const order = [
    ...routes.filter((r) => r.kind === "page"),
    ...routes.filter((r) => r.kind === "api"),
  ];

  const seen = new Set();
  const unique = order.filter((r) => !seen.has(r.kind + r.path) && seen.add(r.kind + r.path));

  if (!(await waitForServer())) {
    console.warn("[warm] dev server never came up; nothing warmed");
    return;
  }

  const started = Date.now();
  const timings = [];

  // Sequential on purpose. Twenty parallel requests make the compiler contend
  // with itself and finish later than doing them in order.
  for (const route of unique) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + route.path, {
        method: SAFE_METHOD,
        // A redirect to /login, or a 401 from an API route, is a perfectly good
        // warm: the route compiled, which is the entire point.
        redirect: "manual",
        headers: { "x-warmup": "1" },
      });

      // FETCHING THE HTML IS NOT ENOUGH.
      //
      // It compiles the route on the server, but the browser bundle for the
      // page is a separate build that happens when something actually asks for
      // those files. So the page still stalled on first click, just at a
      // different step. Requesting the assets it references compiles that half
      // too — which is the difference between "warmed" and "warmed usefully".
      if (route.kind === "page" && res.ok) {
        const html = await res.text().catch(() => "");
        const assets = new Set();
        for (const m of html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)) {
          assets.add(m[1]);
        }
        for (const asset of assets) {
          await fetch(BASE + asset, { headers: { "x-warmup": "1" } }).catch(() => {});
        }
      }

      timings.push({ path: route.path, ms: Date.now() - t0 });
    } catch {
      /* a route that refuses to warm is not worth failing startup over */
    }
  }

  // Printed as a table rather than a single number: when something is slow,
  // the useful question is WHICH route, and this answers it without anyone
  // having to reproduce the problem by hand.
  const slow = timings.sort((a, b) => b.ms - a.ms).slice(0, 8).filter((t) => t.ms > 300);
  console.log(
    `\n[warm] ${unique.length} routes compiled in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  if (slow.length) {
    console.log("[warm] slowest to compile:");
    for (const t of slow) console.log(`[warm]   ${String(t.ms).padStart(6)}ms  ${t.path}`);
  }
}

main();
