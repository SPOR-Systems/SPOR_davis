/**
 * ============================================================================
 *  PROVIDER RESILIENCE
 * ============================================================================
 *  Four failure modes, four different correct responses:
 *
 *    503  = GOOGLE'S capacity. Retry briefly, then fall down the chain, and
 *           remember the model is hot so the next request skips it.
 *    429  = YOUR quota. Wait exactly as long as RetryInfo.retryDelay says.
 *    404/403 = THIS MODEL is unusable with this key. Disqualify the model, not
 *           the request. All models unusable = a config bug with its own type.
 *    else = the request is bad. Fail fast.
 *
 *  TIME BUDGETING (the hard part)
 *  ------------------------------
 *  A congested model does not fail fast — it HANGS, then fails. Observed: ~27s
 *  per attempt against a busy model. That makes a naive chain useless, because
 *  the primary eats the entire deadline and the fallback never runs:
 *
 *    3 attempts x 27s = 81s of a 60s budget, chain aborted, zero fallbacks tried
 *
 *  So the budget is divided, not shared. Every model in the chain is guaranteed
 *  a minimum slice, each individual call is capped, and the cap is handed down
 *  to the caller as a real timeout + AbortSignal so it is enforced inside the
 *  call rather than merely checked between calls.
 *
 *  HEDGING
 *  -------
 *  Budgeting bounds the damage; hedging avoids it. When a model is known to be
 *  flaky we start the next candidate in parallel after a short delay and take
 *  whichever answers first, aborting the loser.
 *
 *  Hedging is deliberately CONDITIONAL. A healthy high-thinking model can take
 *  5-15s legitimately, so hedging every request would roughly double token
 *  spend for no benefit. It arms only for a model that has actually failed
 *  within the recent window (or when DAVIS_HEDGE_ALWAYS=true).
 *
 *  Provider-agnostic: nothing here imports a vendor SDK.
 * ============================================================================
 */

export type FailureCode =
  | "PROVIDER_OVERLOADED"
  | "QUOTA_EXCEEDED"
  | "MODEL_CONFIGURATION"
  | "PROVIDER_ERROR";

export class ProviderOverloadedError extends Error {
  readonly code: FailureCode = "PROVIDER_OVERLOADED";
  readonly retryAfterMs?: number;
  readonly modelsTried: string[];

  constructor(message: string, modelsTried: string[] = [], retryAfterMs?: number) {
    super(message);
    this.name = "ProviderOverloadedError";
    this.modelsTried = modelsTried;
    this.retryAfterMs = retryAfterMs;
  }
}

export class QuotaExceededError extends Error {
  readonly code: FailureCode = "QUOTA_EXCEEDED";
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "QuotaExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * DAVIS's own timeout fired — we stopped waiting, the provider never answered.
 *
 * This must not be confused with a provider failure. Conflating the two caused
 * a nasty compounding bug: a 12s timeout on a legitimately slow high-thinking
 * call was classified as "transient", treated as an overload, and used to cool
 * the model down for 60s — condemning three healthy models in a row and
 * reporting "Gemini has no capacity" when Gemini had never actually complained.
 */
export class LocalTimeoutError extends Error {
  readonly code = "LOCAL_TIMEOUT";
  readonly isLocalTimeout = true;
  readonly timeoutMs: number;
  readonly model: string;

  constructor(model: string, timeoutMs: number) {
    super(
      `DAVIS stopped waiting for ${model} after ${timeoutMs}ms (its own timeout, ` +
      `not an error from the provider). If this recurs, raise ` +
      `DAVIS_SQL_CALL_TIMEOUT_MS / DAVIS_PROSE_CALL_TIMEOUT_MS — a high ` +
      `thinking level can legitimately need far longer.`
    );
    this.name = "LocalTimeoutError";
    this.model = model;
    this.timeoutMs = timeoutMs;
  }
}

export class ModelConfigurationError extends Error {
  readonly code: FailureCode = "MODEL_CONFIGURATION";
  readonly modelsTried: string[];
  readonly reasons: Record<string, string>;

  constructor(message: string, modelsTried: string[], reasons: Record<string, string>) {
    super(message);
    this.name = "ModelConfigurationError";
    this.modelsTried = modelsTried;
    this.reasons = reasons;
  }
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

export type Classification =
  | "quota"
  | "overloaded"
  | "transient"
  | "local_timeout"
  | "model_unavailable"
  | "fatal";

function statusOf(error: any): number | undefined {
  if (typeof error?.status === "number") return error.status;
  const m = String(error?.message || "").match(/"code"\s*:\s*(\d{3})/);
  if (m) return Number(m[1]);
  const m2 = String(error?.message || "").match(/\b(4\d{2}|5\d{2})\b/);
  return m2 ? Number(m2[1]) : undefined;
}

export function classifyError(error: any): Classification {
  // Checked first and by identity, not by message text: our own timeout says
  // nothing about the provider's health and must never cool a model down.
  if (error?.isLocalTimeout === true || error instanceof LocalTimeoutError) {
    return "local_timeout";
  }

  const status = statusOf(error);
  const msg = String(error?.message || "").toLowerCase();

  if (status === 429 || msg.includes("resource_exhausted") || msg.includes("quota")) {
    return "quota";
  }

  // A model that does not exist for this key, e.g. the 404 Google returns for a
  // retired model: "This model models/x is no longer available to new users."
  if (
    status === 404 ||
    status === 403 ||
    msg.includes("not_found") ||
    msg.includes("permission_denied") ||
    msg.includes("no longer available") ||
    msg.includes("is not found") ||
    msg.includes("does not have access")
  ) {
    return "model_unavailable";
  }

  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    msg.includes("overloaded") ||
    msg.includes("unavailable")
  ) {
    return "overloaded";
  }

  if (
    status === 500 ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("network")
  ) {
    return "transient";
  }

  if (
    status === 400 &&
    (msg.includes("not supported") ||
      msg.includes("unsupported") ||
      msg.includes("unknown name") ||
      msg.includes("invalid model") ||
      msg.includes("thinking"))
  ) {
    return "model_unavailable";
  }

  return "fatal";
}

export function parseRetryDelayMs(error: any): number | undefined {
  const haystack = [
    String(error?.message || ""),
    (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return "";
      }
    })(),
  ].join(" ");

  const seconds = haystack.match(/"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);

  const header = haystack.match(/retry-after"?\s*:\s*"?(\d+)"?/i);
  if (header) return Number(header[1]) * 1000;

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Quota introspection                                                        */
/* -------------------------------------------------------------------------- */

export interface QuotaViolation {
  quotaId?: string;
  quotaMetric?: string;
  quotaValue?: string;
  model?: string;
  /** Limit is scoped to one model, so another model may still have headroom. */
  perModel: boolean;
  /** Limit is the free tier's, which no amount of retrying will widen. */
  freeTier: boolean;
}

/**
 * A 429 body carries a google.rpc.QuotaFailure saying exactly which limit was
 * hit. Reading it is the difference between "the API is busy" (wrong, and what
 * this code used to assume) and "your project is capped at 10 requests per
 * minute" (right, and actionable).
 */
export function parseQuotaViolation(error: any): QuotaViolation | null {
  const raw = [
    String(error?.message || ""),
    (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return "";
      }
    })(),
  ].join(" ");

  if (!/quota|resource_exhausted/i.test(raw)) return null;

  const pick = (field: string): string | undefined => {
    const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "i"));
    return m ? m[1] : undefined;
  };

  const quotaId = pick("quotaId");
  const quotaMetric = pick("quotaMetric");
  const quotaValue = pick("quotaValue");
  const model = pick("model");
  const blob = [quotaId, quotaMetric, raw].filter(Boolean).join(" ");

  return {
    quotaId,
    quotaMetric,
    quotaValue,
    model,
    perModel: /permodel/i.test(blob),
    freeTier: /free_?tier/i.test(blob),
  };
}

/** Human-readable explanation for the logs and the UI. */
export function describeQuota(v: QuotaViolation | null): string {
  if (!v) return "Quota exceeded (the API did not say which limit).";
  const parts: string[] = [];
  if (v.quotaValue && v.quotaId) {
    parts.push(`limit ${v.quotaValue} (${v.quotaId})`);
  } else if (v.quotaId) {
    parts.push(v.quotaId);
  }
  if (v.model) parts.push(`for ${v.model}`);
  if (v.freeTier) {
    parts.push(
      "— this is a FREE TIER limit. Enabling billing on the project moves you " +
      "to Tier 1 (far higher RPM, no minimum spend)."
    );
  }
  return parts.join(" ") || "Quota exceeded.";
}

/* -------------------------------------------------------------------------- */
/* Model health                                                               */
/* -------------------------------------------------------------------------- */

/** 404/403 never fixes itself, so the model is dropped for this process. */
const disqualified = new Map<string, string>();

/** A model that exhausted its retries is skipped briefly. */
const coolingUntil = new Map<string, number>();

/** Last time a model failed for a capacity reason — this is what arms hedging. */
const lastFailureAt = new Map<string, number>();

const COOLDOWN_MS = Number(process.env.DAVIS_MODEL_COOLDOWN_MS || 60_000);

/**
 * LOW-QUOTA MODE
 *
 * Once the account has actually returned a 429, the scarce resource is
 * REQUESTS, not model capacity. Everything that spends extra requests to buy
 * reliability — retries, walking the chain, hedging, the prose call — becomes
 * counter-productive: it is what exhausts the bucket in the first place.
 *
 * While this is set, callers are expected to spend the minimum: one request per
 * question, no hedging, no chain walking.
 */
let lowQuotaUntil = 0;
let lastQuotaViolation: QuotaViolation | null = null;
const LOW_QUOTA_WINDOW_MS = Number(process.env.DAVIS_LOW_QUOTA_WINDOW_MS || 120_000);

export function isLowQuota(): boolean {
  return Date.now() < lowQuotaUntil;
}

export function lastQuota(): QuotaViolation | null {
  return lastQuotaViolation;
}

function enterLowQuota(violation: QuotaViolation | null): void {
  lowQuotaUntil = Date.now() + LOW_QUOTA_WINDOW_MS;
  lastQuotaViolation = violation;
}
const HEDGE_WINDOW_MS = Number(process.env.DAVIS_HEDGE_WINDOW_MS || 10 * 60_000);
const HEDGE_ALWAYS = String(process.env.DAVIS_HEDGE_ALWAYS || "").toLowerCase() === "true";

export function isDisqualified(model: string): boolean {
  return disqualified.has(model);
}

export function isCoolingDown(model: string): boolean {
  const until = coolingUntil.get(model);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    coolingUntil.delete(model);
    return false;
  }
  return true;
}

/**
 * Should we hedge behind this model? Only if it has misbehaved recently — a
 * healthy model taking 8s to think is not a reason to spend twice the tokens.
 */
export function shouldHedge(model: string): boolean {
  if (HEDGE_ALWAYS) return true;
  const last = lastFailureAt.get(model);
  return last !== undefined && Date.now() - last < HEDGE_WINDOW_MS;
}

function noteFailure(model: string): void {
  lastFailureAt.set(model, Date.now());
}

export function modelHealth() {
  const now = Date.now();
  return {
    disqualified: Object.fromEntries(disqualified),
    coolingDown: Object.fromEntries(
      [...coolingUntil.entries()]
        .filter(([, until]) => until > now)
        .map(([m, until]) => [m, Math.ceil((until - now) / 1000) + "s remaining"])
    ),
    hedgeArmed: Object.fromEntries(
      [...lastFailureAt.entries()]
        .filter(([m]) => shouldHedge(m))
        .map(([m, at]) => [m, Math.round((now - at) / 1000) + "s since last failure"])
    ),
    cooldownMs: COOLDOWN_MS,
    hedgeWindowMs: HEDGE_WINDOW_MS,
    hedgeAlways: HEDGE_ALWAYS,
    lowQuotaMode: isLowQuota(),
    lowQuotaSecondsRemaining: isLowQuota()
      ? Math.ceil((lowQuotaUntil - now) / 1000)
      : 0,
    lastQuotaViolation: lastQuotaViolation
      ? { ...lastQuotaViolation, explanation: describeQuota(lastQuotaViolation) }
      : null,
    rateLimiter: bucket.stats,
  };
}

export function resetModelHealth(): void {
  disqualified.clear();
  coolingUntil.clear();
  lastFailureAt.clear();
  lowQuotaUntil = 0;
  lastQuotaViolation = null;
}

/* -------------------------------------------------------------------------- */
/* Concurrency limiter                                                        */
/* -------------------------------------------------------------------------- */

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) { }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release() {
    // Hand the slot straight to the next waiter; decrement-then-increment
    // leaves a window where a new caller sees an already-promised slot.
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  get stats() {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }
}

const MAX_CONCURRENT = Number(process.env.DAVIS_MAX_CONCURRENT_AI || 4);
const limiter = new Semaphore(MAX_CONCURRENT);

export function limiterStats() {
  return limiter.stats;
}

/* -------------------------------------------------------------------------- */
/* Rate limiter                                                               */
/* -------------------------------------------------------------------------- */

/**
 * THE THING THAT WAS MISSING.
 *
 * The semaphore above caps CONCURRENCY. It does not cap RATE. Four concurrent
 * slots with fast calls will happily push 40 requests a minute at a project
 * whose ceiling is 10 — and every request over the line comes back 429, which
 * this code then read as "the model is overloaded" and answered by sending
 * MORE requests. That feedback loop is what made a working app unusable.
 *
 * A token bucket set slightly under the account's real limit turns that into
 * queueing, which is slower but always correct. Requests wait for a token
 * instead of being thrown away by the provider.
 *
 * Set DAVIS_RPM_LIMIT to just under your tier's requests-per-minute:
 *   free tier   ~10 RPM  -> 8
 *   Tier 1    ~1000 RPM  -> 200 is plenty for a chat app
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly rpm: number) {
    this.tokens = rpm;
  }

  private refill() {
    const now = Date.now();
    const gained = ((now - this.lastRefill) / 60_000) * this.rpm;
    if (gained > 0) {
      this.tokens = Math.min(this.rpm, this.tokens + gained);
      this.lastRefill = now;
    }
  }

  private msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rpm) * 60_000);
  }

  private tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait for a token. Returns the ms waited, or null if it would take too long. */
  async take(maxWaitMs: number): Promise<number | null> {
    let waited = 0;
    for (let guard = 0; guard < 100; guard++) {
      if (this.tryTake()) return waited;
      const need = this.msUntilToken();
      if (need > maxWaitMs - waited) return null;
      await sleep(Math.min(need, maxWaitMs - waited) + 5);
      waited += need + 5;
    }
    return this.tryTake() ? waited : null;
  }

  /** Refill to full. For tests, and for after an operator raises their tier. */
  reset() {
    this.tokens = this.rpm;
    this.lastRefill = Date.now();
  }

  get stats() {
    this.refill();
    return {
      rpm: this.rpm,
      tokensAvailable: Math.floor(this.tokens),
      msUntilNextToken: this.msUntilToken(),
    };
  }
}

const RPM_LIMIT = Number(process.env.DAVIS_RPM_LIMIT || 200);
const RATE_WAIT_CAP_MS = Number(process.env.DAVIS_RATE_WAIT_CAP_MS || 15_000);
const bucket = new TokenBucket(RPM_LIMIT);

export function rateLimiterStats() {
  return bucket.stats;
}

export function resetRateLimiter() {
  bucket.reset();
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

function fullJitter(attempt: number, baseMs: number, capMs: number): number {
  const window = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * window);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface RetryPolicy {
  /** Retries per model for capacity failures, before falling back. */
  overloadedAttempts: number;
  /** Retries per model for quota failures. */
  quotaAttempts: number;
  baseMs: number;
  capMs: number;
  /** Wall-clock ceiling for the whole chain. */
  totalDeadlineMs: number;
  /** Ceiling for any single model, so it cannot starve the rest of the chain. */
  perModelCapMs: number;
  /** Ceiling for any single call. A hanging call is cut here. */
  perCallCapMs: number;
  /** Guaranteed slice reserved for each model still to be tried. */
  minModelBudgetMs: number;
  /** Start the next candidate in parallel after this long. 0 disables. */
  hedgeDelayMs: number;
  /** How many candidates may run in parallel while hedging. */
  hedgeMaxParallel: number;
  /**
   * Hard ceiling on provider requests one question may spend. This is the
   * knob that actually protects a rate-limited account: no combination of
   * retries, chain walking and hedging can exceed it.
   */
  maxRequestsPerCall: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  // ZERO retries by default. When requests are the scarce resource, spending
  // one on the SAME congested model is the worst available option — a different
  // model in the chain is strictly more likely to answer. Retries only make
  // sense with RPM headroom.
  overloadedAttempts: Number(process.env.DAVIS_OVERLOAD_ATTEMPTS || 0),
  quotaAttempts: Number(process.env.DAVIS_QUOTA_ATTEMPTS || 1),
  baseMs: Number(process.env.DAVIS_BACKOFF_BASE_MS || 400),
  capMs: Number(process.env.DAVIS_BACKOFF_CAP_MS || 2500),
  // These were sized for a rate-limited free tier, where failing fast to save
  // a request was the priority. That was the wrong trade: a thinking model on
  // a multi-thousand-token schema can legitimately need 20-40s, and a 12s
  // ceiling was killing calls that would have succeeded.
  totalDeadlineMs: Number(process.env.DAVIS_TOTAL_DEADLINE_MS || 90_000),
  perModelCapMs: Number(process.env.DAVIS_PER_MODEL_CAP_MS || 60_000),
  perCallCapMs: Number(process.env.DAVIS_PER_CALL_CAP_MS || 45_000),
  minModelBudgetMs: Number(process.env.DAVIS_MIN_MODEL_BUDGET_MS || 15_000),
  // OFF by default. Hedging spends an extra request to buy latency, which is
  // the right trade against a congested model and exactly the wrong one
  // against a rate-limited account. Opt in only if you have RPM headroom.
  hedgeDelayMs: Number(process.env.DAVIS_HEDGE_DELAY_MS || 0),
  hedgeMaxParallel: Number(process.env.DAVIS_HEDGE_MAX_PARALLEL || 2),
  maxRequestsPerCall: Number(process.env.DAVIS_MAX_REQUESTS_PER_CALL || 3),
};

/**
 * A chain longer than the request budget can never be fully walked. That is a
 * legitimate choice (the budget protects the quota), but it should be a visible
 * one rather than a silently unreachable tail.
 */
export function warnIfChainExceedsBudget(
  chain: string[],
  policy: RetryPolicy = DEFAULT_POLICY,
  label = "chain"
): void {
  const needed = chain.length * (policy.overloadedAttempts + 1);
  if (needed > policy.maxRequestsPerCall) {
    console.warn(
      `[davis] ${label}: ${chain.length} models x ${policy.overloadedAttempts + 1} ` +
      `attempt(s) needs ${needed} requests but the budget is ` +
      `${policy.maxRequestsPerCall}, so the tail of the chain ` +
      `(${chain.slice(Math.floor(policy.maxRequestsPerCall / (policy.overloadedAttempts + 1))).join(", ") || "none"}) ` +
      `may never be reached. This is intentional on a rate-limited key; raise ` +
      `DAVIS_MAX_REQUESTS_PER_CALL if your tier has headroom.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Call wrapper                                                               */
/* -------------------------------------------------------------------------- */

/** Handed to the caller so the timeout is enforced inside the request. */
export interface AttemptContext {
  timeoutMs: number;
  signal: AbortSignal;
}

export type ModelFn<T> = (model: string, ctx: AttemptContext) => Promise<T>;

export interface CallMeta {
  modelUsed: string;
  degraded: boolean;
  modelsTried: string[];
  attempts: number;
  waitedMs: number;
  /** True when a parallel hedge produced the winning answer. */
  hedged?: boolean;
  skipped?: Record<string, string>;
}

export interface CallResult<T> {
  value: T;
  meta: CallMeta;
}

interface Settled<T> {
  id: number;
  model: string;
  ok: boolean;
  value?: T;
  error?: any;
}

/** One attempt, with a hard timeout that aborts the underlying request. */
function launchAttempt<T>(
  id: number,
  model: string,
  fn: ModelFn<T>,
  timeoutMs: number,
  label = "model call"
): { promise: Promise<Settled<T>>; abort: () => void } {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const promise = Promise.resolve()
    .then(() => fn(model, { timeoutMs, signal: controller.signal }))
    .then((value): Settled<T> => {
      console.log(
        `[davis] ${label}: ${model} answered in ${Date.now() - startedAt}ms ` +
        `(timeout was ${timeoutMs}ms)`
      );
      return { id, model, ok: true, value };
    })
    .catch((raw): Settled<T> => {
      const elapsed = Date.now() - startedAt;
      const error = controller.signal.aborted
        ? new LocalTimeoutError(model, timeoutMs)
        : raw;
      // Log the provider's ACTUAL words plus the duration. Previously this was
      // swallowed, so a local timeout and a real 503 looked identical in the
      // logs and there was no way to tell which was happening.
      console.warn(
        `[davis] ${label}: ${model} failed after ${elapsed}ms ` +
        `[${classifyError(error)}] ${String(error?.message || error).slice(0, 400)}`
      );
      return { id, model, ok: false, error };
    })
    .finally(() => clearTimeout(timer));

  return {
    promise,
    abort: () => {
      clearTimeout(timer);
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    },
  };
}

/**
 * Staggered race: launch the first candidate, and if it has not answered within
 * hedgeDelayMs launch the next one alongside it. First success wins and the
 * losers are aborted, so a hanging model costs the delay, not its full timeout.
 */
async function hedgedRace<T>(
  models: string[],
  fn: ModelFn<T>,
  opts: { timeoutMs: number; hedgeDelayMs: number; label: string }
): Promise<{ winner: Settled<T> | null; failures: Settled<T>[]; attempts: number }> {
  const pending = new Map<number, Promise<Settled<T>>>();
  const aborts = new Map<number, () => void>();
  const failures: Settled<T>[] = [];
  let nextId = 0;
  let attempts = 0;

  const launch = () => {
    const model = models[nextId];
    const id = nextId++;
    const { promise, abort } = launchAttempt(id, model, fn, opts.timeoutMs);
    pending.set(id, promise);
    aborts.set(id, abort);
    attempts++;
    if (id > 0) {
      console.warn(
        `[davis] ${opts.label}: hedging — starting ${model} in parallel because ` +
        `${models[0]} has not answered in ${opts.hedgeDelayMs}ms`
      );
    }
  };

  const abortAll = () => {
    for (const abort of aborts.values()) abort();
  };

  launch();

  try {
    while (pending.size > 0) {
      const canHedge = nextId < models.length;

      let hedgeTimer: NodeJS.Timeout | undefined;
      const racers: Promise<Settled<T> | "hedge">[] = [...pending.values()];
      if (canHedge) {
        racers.push(
          new Promise<"hedge">((resolve) => {
            hedgeTimer = setTimeout(() => resolve("hedge"), opts.hedgeDelayMs);
          })
        );
      }

      const first = await Promise.race(racers);
      if (hedgeTimer) clearTimeout(hedgeTimer);

      if (first === "hedge") {
        launch();
        continue;
      }

      const settled = first as Settled<T>;
      pending.delete(settled.id);
      aborts.delete(settled.id);

      if (settled.ok) {
        abortAll();
        return { winner: settled, failures, attempts };
      }

      failures.push(settled);

      // A bad request is bad regardless of which model served it.
      if (classifyError(settled.error) === "fatal") {
        abortAll();
        throw settled.error;
      }

      // Nothing in flight and nothing left to start.
      if (pending.size === 0 && nextId >= models.length) break;
      if (pending.size === 0) launch();
    }

    return { winner: null, failures, attempts };
  } finally {
    abortAll();
  }
}

/**
 * Run `fn` against the first model in `chain` that can serve it, within a
 * divided time budget.
 */
export async function callWithFallback<T>(
  chain: string[],
  fn: ModelFn<T>,
  policyOverrides: Partial<RetryPolicy> = {},
  label = "model call"
): Promise<CallResult<T>> {
  // Merge rather than replace: a caller passing one field must not silently
  // lose the deadline, which would uncap request latency.
  let policy: RetryPolicy = { ...DEFAULT_POLICY, ...(policyOverrides || {}) };

  // Under a known quota ceiling, requests are the scarce resource. Collapse to
  // a single call: no hedging, no retries, no chain walking. Better one honest
  // attempt than six that all come back 429.
  if (isLowQuota()) {
    policy = {
      ...policy,
      hedgeDelayMs: 0,
      overloadedAttempts: 0,
      quotaAttempts: 0,
      maxRequestsPerCall: 1,
    };
  }

  const configured = chain.filter(Boolean);
  if (configured.length === 0) throw new Error("No model configured.");

  const skipped: Record<string, string> = {};
  const usable = configured.filter((m) => {
    if (isDisqualified(m)) {
      skipped[m] = disqualified.get(m) || "disqualified";
      return false;
    }
    return true;
  });

  if (usable.length === 0) {
    throw new ModelConfigurationError(
      `None of the configured models are usable with this API key: ${configured.join(", ")}. ` +
      `Fix DAVIS_SQL_MODEL_CHAIN / DAVIS_PROSE_MODEL_CHAIN.`,
      configured,
      { ...skipped }
    );
  }

  // Cooling-down models go last rather than being retried first.
  const hot = usable.filter((m) => !isCoolingDown(m));
  const cool = usable.filter((m) => isCoolingDown(m));
  for (const m of cool) skipped[m] = "cooling down after a recent overload";
  const order = [...hot, ...cool];

  const startedAt = Date.now();
  const deadline = startedAt + policy.totalDeadlineMs;
  const remaining = () => deadline - Date.now();

  const modelsTried: string[] = [];
  const reasons: Record<string, string> = {};
  let totalAttempts = 0;
  let waitedMs = 0;
  let lastQuotaDelay: number | undefined;
  let lastError: any;
  let sawQuota = false;
  let sawOverload = false;
  let outOfTime = false;
  let outOfBudget = false;
  let sawLocalTimeout = false;
  let quotaIsProjectWide = false;
  const quotaFailedModels = new Set<string>();

  /**
   * Each model is guaranteed a slice. Without the reserve term the primary can
   * legally consume the whole deadline and the fallback never runs — which is
   * exactly the bug this replaces.
   */
  const budgetFor = (index: number): number => {
    const modelsLeftAfterThis = Math.max(0, order.length - index - 1);
    const reserve = modelsLeftAfterThis * policy.minModelBudgetMs;
    const available = remaining() - reserve;
    return Math.max(
      0,
      Math.min(policy.perModelCapMs, Math.max(available, Math.min(policy.minModelBudgetMs, remaining())))
    );
  };

  const noteResult = (model: string, error: any): Classification => {
    const kind = classifyError(error);
    if (kind === "model_unavailable") {
      const why = String(error?.message || "").slice(0, 300);
      disqualified.set(model, why);
      reasons[model] = why;
      console.error(
        `[davis] ${label}: model "${model}" is not usable with this API key — ` +
        `disqualifying it for the rest of this process and moving on. ${why}`
      );
    } else if (kind === "quota") {
      sawQuota = true;
      const violation = parseQuotaViolation(error);
      reasons[model] = `quota: ${describeQuota(violation)}`;
      noteFailure(model);
      enterLowQuota(violation);
      console.error(
        `[davis] ${label}: QUOTA EXCEEDED on ${model} — ${describeQuota(violation)}`
      );
      // Scope decides whether falling back is worth a request:
      //   - explicitly project-wide  -> every model shares the exhausted
      //     bucket, so stop immediately.
      //   - explicitly per-model     -> another model has its own allowance,
      //     so falling back is worth one request.
      //   - unstated (a bare 429 with no QuotaFailure body) -> unknowable from
      //     one response. Gemini's common free-tier limit IS per-model, so we
      //     allow one fallback; but if a SECOND model also 429s, the limit is
      //     evidently project-wide and we stop there.
      quotaFailedModels.add(model);
      if (violation && violation.perModel === false && violation.quotaId) {
        quotaIsProjectWide = true;
      } else if (quotaFailedModels.size >= 2) {
        quotaIsProjectWide = true;
        console.error(
          `[davis] ${label}: two different models returned 429 ` +
          `(${[...quotaFailedModels].join(", ")}) — the limit is project-wide, ` +
          "so no further model is worth a request"
        );
      }
    } else if (kind === "local_timeout") {
      // Our clock ran out; the provider said nothing. No cooldown, no
      // "recently failed" mark, and this is NOT counted as a provider outage.
      sawLocalTimeout = true;
      reasons[model] = `DAVIS timed out after ${(error as any)?.timeoutMs ?? "?"}ms`;
    } else if (kind === "overloaded" || kind === "transient") {
      sawOverload = true;
      reasons[model] = kind;
      noteFailure(model);
    }
    return kind;
  };

  const release = await limiter.acquire();

  try {
    /* ---------------------------------------------------------------------- */
    /* Phase 1: hedged opening, only when the primary is known to be flaky    */
    /* ---------------------------------------------------------------------- */
    const hedgeCandidates = order.slice(0, Math.max(1, policy.hedgeMaxParallel));

    if (
      policy.hedgeDelayMs > 0 &&
      hedgeCandidates.length >= 2 &&
      shouldHedge(order[0]) &&
      remaining() > policy.minModelBudgetMs
    ) {
      const timeoutMs = Math.max(
        1000,
        Math.min(policy.perCallCapMs, budgetFor(0) || policy.perCallCapMs)
      );

      for (const m of hedgeCandidates) if (!modelsTried.includes(m)) modelsTried.push(m);

      const { winner, failures, attempts } = await hedgedRace(hedgeCandidates, fn, {
        timeoutMs,
        hedgeDelayMs: policy.hedgeDelayMs,
        label,
      });
      totalAttempts += attempts;

      if (winner) {
        return {
          value: winner.value as T,
          meta: {
            modelUsed: winner.model,
            degraded: winner.model !== configured[0],
            modelsTried,
            attempts: totalAttempts,
            waitedMs,
            hedged: true,
            skipped: Object.keys(skipped).length ? skipped : undefined,
          },
        };
      }

      for (const f of failures) {
        lastError = f.error;
        noteResult(f.model, f.error);
        const delay = parseRetryDelayMs(f.error);
        if (delay !== undefined) lastQuotaDelay = delay;
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Phase 2: sequential walk, each model inside its own budget             */
    /* ---------------------------------------------------------------------- */
    for (let i = 0; i < order.length; i++) {
      if (quotaIsProjectWide) break;
      const model = order[i];
      if (isDisqualified(model)) continue;

      if (outOfBudget) break;
      if (remaining() <= 0) {
        outOfTime = true;
        break;
      }

      if (!modelsTried.includes(model)) modelsTried.push(model);

      const modelBudget = budgetFor(i);
      const modelDeadline = Date.now() + modelBudget;
      const modelRemaining = () => modelDeadline - Date.now();

      let overloadedTries = 0;
      let quotaTries = 0;

      for (; ;) {
        if (modelRemaining() <= 0 || remaining() <= 0) {
          // Only cool down if the PROVIDER actually misbehaved; running out of
          // our own budget says nothing about the model.
          if (sawOverload && !sawLocalTimeout) {
            coolingUntil.set(model, Date.now() + COOLDOWN_MS);
          }
          console.warn(
            `[davis] ${label}: ${model} exhausted its ${modelBudget}ms slice — ` +
            `moving on so the rest of the chain still gets a turn`
          );
          break;
        }

        if (totalAttempts >= policy.maxRequestsPerCall) {
          console.warn(
            `[davis] ${label}: request budget of ${policy.maxRequestsPerCall} ` +
            "provider calls is spent — stopping rather than burning more quota"
          );
          outOfBudget = true;
          break;
        }

        // Wait for a rate-limit token BEFORE spending a request. Queueing is
        // strictly better than being 429'd, because a rejected request still
        // counts against the account.
        const waitBudget = Math.min(
          RATE_WAIT_CAP_MS,
          Math.max(0, Math.min(modelRemaining(), remaining()) - 1500)
        );
        const rateWaited = await bucket.take(waitBudget);
        if (rateWaited === null) {
          const stats = bucket.stats;
          throw new QuotaExceededError(
            `DAVIS throttled this request locally to protect your API quota ` +
            `(limit ${stats.rpm}/min, next slot in ~${Math.ceil(
              stats.msUntilNextToken / 1000
            )}s). Raise DAVIS_RPM_LIMIT if your tier allows more.`,
            stats.msUntilNextToken
          );
        }
        if (rateWaited > 0) {
          waitedMs += rateWaited;
          console.warn(
            `[davis] ${label}: waited ${rateWaited}ms for a rate-limit slot ` +
            `(${RPM_LIMIT}/min) before calling ${model}`
          );
        }

        const timeoutMs = Math.max(
          1000,
          Math.min(policy.perCallCapMs, modelRemaining())
        );

        totalAttempts++;
        const { promise } = launchAttempt(totalAttempts, model, fn, timeoutMs, label);
        const settled = await promise;

        if (settled.ok) {
          return {
            value: settled.value as T,
            meta: {
              modelUsed: model,
              degraded: model !== configured[0],
              modelsTried,
              attempts: totalAttempts,
              waitedMs,
              skipped: Object.keys(skipped).length ? skipped : undefined,
            },
          };
        }

        lastError = settled.error;
        const kind = noteResult(model, settled.error);

        if (kind === "fatal") throw settled.error;
        if (kind === "model_unavailable") break;
        if (quotaIsProjectWide) {
          console.error(
            `[davis] ${label}: the quota limit is project-wide, so the rest of ` +
            "the chain would hit the same wall — stopping here"
          );
          break;
        }

        if (kind === "quota") {
          const asked = parseRetryDelayMs(settled.error);
          lastQuotaDelay = asked ?? lastQuotaDelay;

          if (quotaTries >= policy.quotaAttempts) {
            console.warn(
              `[davis] ${label}: quota exhausted on ${model}` +
              (asked ? ` (API asked for ${asked}ms)` : "") +
              " — moving to next model"
            );
            break;
          }

          const delay = asked ?? fullJitter(quotaTries, 2000, 30000);
          if (delay >= Math.min(modelRemaining(), remaining())) {
            console.warn(
              `[davis] ${label}: ${model} wants ${delay}ms, more than its remaining ` +
              "budget — moving on"
            );
            break;
          }

          quotaTries++;
          console.warn(
            `[davis] ${label}: 429 on ${model}, waiting ${delay}ms ` +
            `(attempt ${quotaTries}/${policy.quotaAttempts})`
          );
          waitedMs += delay;
          await sleep(delay);
          continue;
        }

        // A local timeout is our impatience, not the model's health. Move on
        // without cooling it down, so a too-short timeout cannot cascade into
        // "every model is unavailable".
        if (kind === "local_timeout") {
          console.warn(
            `[davis] ${label}: giving up on ${model} because DAVIS's own ` +
            `${timeoutMs}ms timeout fired — NOT marking the model unhealthy`
          );
          break;
        }

        // overloaded or transient
        if (overloadedTries >= policy.overloadedAttempts) {
          coolingUntil.set(model, Date.now() + COOLDOWN_MS);
          console.warn(
            `[davis] ${label}: ${model} returned a provider failure after ` +
            `${overloadedTries} retries — falling back and cooling it down ` +
            `for ${Math.round(COOLDOWN_MS / 1000)}s`
          );
          break;
        }

        const delay = fullJitter(overloadedTries, policy.baseMs, policy.capMs);
        if (delay >= Math.min(modelRemaining(), remaining())) {
          coolingUntil.set(model, Date.now() + COOLDOWN_MS);
          console.warn(`[davis] ${label}: out of budget on ${model} — falling back`);
          break;
        }

        overloadedTries++;
        console.warn(
          `[davis] ${label}: ${kind} on ${model}, retrying in ${delay}ms ` +
          `(attempt ${overloadedTries}/${policy.overloadedAttempts})`
        );
        waitedMs += delay;
        await sleep(delay);
      }
    }

    /* --- Nothing served the request. Say precisely why. --- */

    // Our own timeout: not a quota problem, not an outage, and NOT a
    // configuration problem. This must be decided before the config branch,
    // which would otherwise claim every failure it cannot otherwise explain.
    if (sawLocalTimeout && !sawOverload && !sawQuota) {
      throw new LocalTimeoutError(modelsTried.join(", "), policy.perCallCapMs);
    }

    if (
      !sawQuota &&
      !sawOverload &&
      !sawLocalTimeout &&
      Object.keys(reasons).length > 0
    ) {
      throw new ModelConfigurationError(
        `None of the configured models are usable with this API key: ${configured.join(", ")}.`,
        configured,
        { ...skipped, ...reasons }
      );
    }

    if (sawQuota && (quotaIsProjectWide || !sawOverload)) {
      throw new QuotaExceededError(
        `Gemini API quota exceeded. ${describeQuota(lastQuotaViolation)}`,
        lastQuotaDelay
      );
    }

    throw new ProviderOverloadedError(
      outOfBudget
        ? `Spent the ${policy.maxRequestsPerCall}-request budget for one question ` +
        `without an answer; tried ${modelsTried.join(", ")}. Raise ` +
        `DAVIS_MAX_REQUESTS_PER_CALL only if your API tier has the headroom.`
        : outOfTime
          ? `Gave up after ${Date.now() - startedAt}ms; tried ${modelsTried.join(", ")}.`
          : `Gemini has no capacity right now for ${modelsTried.join(", ")}.`,
      modelsTried,
      parseRetryDelayMs(lastError)
    );
  } finally {
    release();
  }
}

/** Chain parsing helper: "a, b ,c" -> ["a","b","c"] */
export function parseChain(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}
