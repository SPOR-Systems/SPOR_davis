/**
 * Start the dev server and warm every route behind it.
 *
 * A tiny spawner rather than a `concurrently` dependency: this needs to run
 * before `npm install` has necessarily been re-run, and adding a package to
 * make two processes start is not a trade worth making.
 */
import { spawn } from "node:child_process";

/**
 * NOT --turbo, deliberately.
 *
 * `onDemandEntries` in next.config.mjs is what stops the dev server throwing
 * away compiled pages after fifteen seconds — and it is a WEBPACK option.
 * Turbopack ignores it. Running `next dev --turbo` therefore discards the one
 * setting that keeps pages warm, so every navigation back to a page you already
 * visited recompiles it from scratch.
 *
 * Turbopack is usually faster at the FIRST compile and slower here, because
 * this app's pain is re-compiling the same handful of pages over and over.
 * `npm run dev:turbo` is still there to compare on your own machine.
 */
const next = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "dev"],
  { stdio: "inherit", shell: process.platform === "win32" }
);

const warm = spawn(process.execPath, ["scripts/warm-routes.mjs"], {
  stdio: "inherit",
});

const stop = () => {
  warm.kill();
  next.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", (code) => {
  warm.kill();
  process.exit(code ?? 0);
});
