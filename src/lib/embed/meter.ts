import { AsyncLocalStorage } from "async_hooks";

/**
 * ============================================================================
 *  THE METER
 * ============================================================================
 *  Counts what actually costs money, per request, without threading a counter
 *  argument through every function between the HTTP handler and the SDK call.
 *
 *  WHY ASYNC-LOCAL STORAGE AND NOT A MODULE COUNTER
 *  ------------------------------------------------
 *  A module-level `let providerCalls = 0` is the obvious version and it is
 *  wrong the first time two questions are in flight at once: Node interleaves
 *  them, and one tenant's repair loop lands on another tenant's invoice. The
 *  bug would not show up in testing, where requests arrive one at a time, and
 *  would show up in production as billing that is quietly incorrect.
 *
 *  AsyncLocalStorage gives each request its own bucket that follows it across
 *  every await, which is precisely the shape of the problem.
 *
 *  WHY NOT PASS A PARAMETER
 *  ------------------------
 *  Because the alternative is changing the signature of every generator, every
 *  retry wrapper and every fallback path — and a metering parameter that any
 *  one of them can forget to pass is a meter with holes in it. Here the only
 *  code that has to know about metering is the three places that actually call
 *  the provider.
 * ============================================================================
 */

export interface MeterBucket {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
}

const storage = new AsyncLocalStorage<MeterBucket>();

/** Run `fn` with a fresh bucket, and hand back what it spent. */
export async function withMeter<T>(
  fn: () => Promise<T>
): Promise<{ value: T; spent: MeterBucket }> {
  const bucket: MeterBucket = { providerCalls: 0, inputTokens: 0, outputTokens: 0 };
  const value = await storage.run(bucket, fn);
  return { value, spent: bucket };
}

/**
 * Record one provider call. Called from the SDK call sites.
 *
 * Outside a metered request this is a no-op, so the standalone dashboard pays
 * no attention and nothing has to branch on whether metering is on.
 *
 * Note this counts the CALL, including one that failed or was abandoned as a
 * hedged loser — those were paid for too. What it must never do is count the
 * HTTP request instead: a knowledge question on the fast path makes one call
 * where a data question makes two, and a question needing three repair rounds
 * makes four. Counting requests would flatten all of that into "1" and hide the
 * only number that moves.
 */
export function countProviderCall(tokens?: {
  input?: number | null;
  output?: number | null;
}): void {
  const bucket = storage.getStore();
  if (!bucket) return;
  bucket.providerCalls += 1;
  bucket.inputTokens += Math.max(0, Number(tokens?.input) || 0);
  bucket.outputTokens += Math.max(0, Number(tokens?.output) || 0);
}

/** The running total, for a trace line. Null outside a metered request. */
export function currentSpend(): MeterBucket | null {
  const bucket = storage.getStore();
  return bucket ? { ...bucket } : null;
}
