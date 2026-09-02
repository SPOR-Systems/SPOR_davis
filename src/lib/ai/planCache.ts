import crypto from "crypto";
import type { QueryPlan } from "@/lib/ai/gemini";

/**
 * ============================================================================
 *  PLAN CACHE
 * ============================================================================
 *  Cuts provider calls without ever serving stale data.
 *
 *  We cache the PLAN (the SQL and its reasoning), not the answer. An identical
 *  question, against an unchanged schema, in the same conversational context,
 *  deserves the same query — so on a repeat we skip planning entirely and go
 *  straight to executing it. The query still runs against the live database, so
 *  the numbers are always current.
 *
 *  Effect on the worst case: a repeated question drops from 4 provider calls
 *  (plan + two repairs + prose) to 1 (prose only).
 *
 *  Deliberately NOT cached: the final prose answer. Caching that would mean
 *  reporting yesterday's number today, which is the exact failure this whole
 *  project is trying to eliminate. If you want it anyway for demo double-clicks,
 *  set DAVIS_ANSWER_CACHE_MS above 0 and understand the tradeoff.
 *
 *  This is a per-process cache. Behind several serverless instances each gets
 *  its own; that costs you hit rate, never correctness. Move it to Redis if you
 *  scale out and want shared hits.
 * ============================================================================
 */

const PLAN_TTL_MS = Number(process.env.DAVIS_PLAN_CACHE_MS || 30 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.DAVIS_PLAN_CACHE_SIZE || 500);

interface Entry {
  plan: QueryPlan;
  storedAt: number;
}

const store = new Map<string, Entry>();

/** Whitespace, case and punctuation should not cause a miss. */
function normaliseQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function planCacheKey(args: {
  connectionId: string;
  schemaGeneratedAt: string;
  question: string;
  chatHistory?: string;
  /**
   * Today's date, as injected into the planner prompt.
   *
   * This MUST be part of the identity. The planner bakes the date it was given
   * into the SQL as a literal — e.g. date('2026-09-02','-50 years') for an age
   * filter — so a plan cached on one day and replayed on another silently
   * computes ages against a stale "today". Harmless at the 30-minute default
   * TTL; a wrong answer the moment anyone raises DAVIS_PLAN_CACHE_MS.
   */
  todayISO?: string;
}): string {
  const h = crypto.createHash("sha256");
  h.update(args.connectionId);
  h.update("|");
  // Any schema re-profile invalidates every plan built against the old one.
  h.update(args.schemaGeneratedAt);
  h.update("|");
  // Follow-ups resolve against history, so history is part of the identity.
  h.update(
    crypto.createHash("sha256").update(args.chatHistory || "").digest("hex")
  );
  h.update("|");
  h.update(args.todayISO || "");
  h.update("|");
  h.update(normaliseQuestion(args.question));
  return h.digest("hex");
}

export function getCachedPlan(key: string): QueryPlan | null {
  const hit = store.get(key);
  if (!hit) return null;

  if (Date.now() - hit.storedAt > PLAN_TTL_MS) {
    store.delete(key);
    return null;
  }

  // Refresh recency for the LRU eviction below.
  store.delete(key);
  store.set(key, hit);
  return hit.plan;
}

export function setCachedPlan(key: string, plan: QueryPlan): void {
  // Only cache plans that actually produced a query worth reusing.
  if (plan.intent !== "DATA_QUERY" || !plan.sql) return;

  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { plan, storedAt: Date.now() });
}

export function planCacheStats() {
  return { entries: store.size, ttlMs: PLAN_TTL_MS, maxEntries: MAX_ENTRIES };
}

/** Exposed so a schema refresh can drop everything built on the old schema. */
export function clearPlanCache(): void {
  store.clear();
}
