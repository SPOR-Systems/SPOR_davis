import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  buildAnswerPrompt,
  buildNonDataPrompt,
  buildRepairPrompt,
  buildSqlPrompt,
  PROMPT_VERSION,
  buildKnowledgePrompt,
} from "@/lib/ai/prompts";
import type {
  AnswerChartContext,
  KnowledgePromptInput,
} from "@/lib/ai/prompts";
import {
  callWithFallback,
  ModelConfigurationError,
  modelHealth,
  parseChain,
  rateLimiterStats,
  warnIfChainExceedsBudget,
  type CallMeta,
} from "@/lib/ai/resilience";

const API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: API_KEY });

/**
 * ============================================================================
 *  MODEL CONFIGURATION
 * ============================================================================
 *  Two chains, ordered strongest-first. On a 503 we walk down the chain rather
 *  than failing the question, so an overload degrades answer quality instead of
 *  breaking the feature.
 *
 *  SQL planning is the hard reasoning step and gets gemini-3.7-flash: stable,
 *  built for complex coding and multi-step execution, with thinking turned up.
 *  Preview model IDs are deliberately absent from the default chain — preview
 *  tiers get a fraction of the served capacity and are where 503 storms live.
 *
 *  Answer rendering does no arithmetic (every figure is precomputed in
 *  facts.ts), so it stays on the cheap lite tier with thinking turned down.
 * ============================================================================
 */

/**
 * Chain order is deliberate: the fallback exists BECAUSE the primary ran out of
 * capacity, so falling back to another capacity-constrained model is no help.
 * Each step down trades reasoning depth for available throughput, and the last
 * entry is the tier with the most spare capacity.
 *
 * gemini-2.5-pro is deliberately NOT here: it returns 404 "no longer available
 * to new users" on keys that never used it, which makes it a worse-than-useless
 * fallback. If you want a Pro-tier fallback, gemini-3.1-pro-preview is the
 * current one — but it is preview, so it is the least likely to have spare
 * capacity during exactly the overload you are falling back from.
 */
const SQL_MODEL_CHAIN = parseChain(process.env.DAVIS_SQL_MODEL_CHAIN, [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
]);

const PROSE_MODEL_CHAIN = parseChain(process.env.DAVIS_PROSE_MODEL_CHAIN, [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
]);

/**
 * Ceiling on any single call. The ACTUAL timeout for each attempt is the
 * smaller of this and the model's remaining slice of the request budget.
 *
 * These were 12s/10s, chosen on the assumption that "a healthy high-thinking
 * plan comes back well inside it". That assumption was wrong and unverified:
 * thinkingLevel HIGH over a ~2k-token schema document, with thinking tokens
 * counting against an 8192 output budget, can legitimately run 20-40s. The
 * tight ceiling was aborting calls that would have succeeded and then blaming
 * the provider for it.
 *
 * Every call now logs its duration, so set these from your own numbers rather
 * than from a guess. If planning is consistently slow, the cheapest latency
 * lever is DAVIS_SQL_THINKING_LEVEL=medium.
 */
const SQL_CALL_TIMEOUT_MS = Number(process.env.DAVIS_SQL_CALL_TIMEOUT_MS || 45_000);

/**
 * Output budget for the planner. THINKING TOKENS COUNT AGAINST THIS. At
 * thinkingLevel HIGH over a couple of thousand tokens of schema, 8192 was not
 * enough: the model spent most of it thinking and the JSON came back cut off
 * mid-object, which surfaced as a bare "unparseable response".
 */
const SQL_MAX_OUTPUT_TOKENS = Number(
  process.env.DAVIS_SQL_MAX_OUTPUT_TOKENS || 32_768
);
const PROSE_CALL_TIMEOUT_MS = Number(process.env.DAVIS_PROSE_CALL_TIMEOUT_MS || 25_000);

/**
 * NOTE ON TEMPERATURE — read before adding one back.
 *
 * We deliberately do NOT set temperature. Google's Gemini 3 guidance is to
 * leave it at the default of 1.0, because lowering it on a thinking model "may
 * lead to unexpected behavior, such as looping or degraded performance".
 *
 * On this model generation, determinism comes from thinkingLevel plus a strict
 * output contract, not from clamping the sampler.
 */

function thinkingLevelFromEnv(
  envValue: string | undefined,
  fallback: ThinkingLevel
): ThinkingLevel {
  switch (String(envValue || "").toLowerCase()) {
    case "minimal":
      return ThinkingLevel.MINIMAL;
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
    default:
      return fallback;
  }
}

const SQL_THINKING = thinkingLevelFromEnv(
  process.env.DAVIS_SQL_THINKING_LEVEL,
  ThinkingLevel.HIGH
);
const PROSE_THINKING = thinkingLevelFromEnv(
  process.env.DAVIS_PROSE_THINKING_LEVEL,
  ThinkingLevel.LOW
);

// Surface an unreachable chain tail at startup rather than leaving it to be
// discovered during an outage.
warnIfChainExceedsBudget(SQL_MODEL_CHAIN, undefined, "SQL chain");
warnIfChainExceedsBudget(PROSE_MODEL_CHAIN, undefined, "prose chain");

export const AI_CONFIG = {
  promptVersion: PROMPT_VERSION,
  sqlModelChain: SQL_MODEL_CHAIN,
  proseModelChain: PROSE_MODEL_CHAIN,
  sqlThinking: SQL_THINKING,
  proseThinking: PROSE_THINKING,
};

/**
 * The model hit its output ceiling mid-sentence. The answer that came back is
 * literally incomplete — a half-written table row — so it must never be shown.
 * The caller falls back to the deterministic renderer, which is always whole.
 */
export class OutputTruncatedError extends Error {
  readonly code = "OUTPUT_TRUNCATED";
  constructor(model: string) {
    super(`${model} hit its output token limit before finishing the answer.`);
    this.name = "OutputTruncatedError";
  }
}

/* -------------------------------------------------------------------------- */
/* Model discovery + diagnostics                                              */
/* -------------------------------------------------------------------------- */

let availableModelsCache: { models: string[]; fetchedAt: number } | null = null;
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;

/**
 * What this API key can actually reach. Model IDs shift under you — retirements
 * and "not available to new users" gates are invisible until a call 404s — so
 * when a chain fails we look this up and log it, turning a mystery 404 into a
 * list of IDs that would have worked.
 */
export async function listAvailableModels(
  opts: { force?: boolean } = {}
): Promise<string[]> {
  if (
    !opts.force &&
    availableModelsCache &&
    Date.now() - availableModelsCache.fetchedAt < MODEL_LIST_TTL_MS
  ) {
    return availableModelsCache.models;
  }

  const models: string[] = [];
  try {
    const pager = await ai.models.list();
    for await (const m of pager) {
      if (m.name) models.push(m.name.replace(/^models\//, ""));
      if (models.length >= 200) break; // guard against a runaway pager
    }
    availableModelsCache = { models, fetchedAt: Date.now() };
  } catch (error: any) {
    console.error(
      "[davis] could not list available models:",
      error?.message || error
    );
  }
  return models;
}

/**
 * Wraps a chain call so that a configuration failure explains itself. Without
 * this, "none of the configured models are usable" leaves you guessing which
 * IDs to try next.
 */
async function withModelDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (error instanceof ModelConfigurationError) {
      const available = await listAvailableModels();
      console.error(
        "[davis] MODEL CONFIGURATION PROBLEM\n" +
          `  configured: ${error.modelsTried.join(", ")}\n` +
          `  rejected because: ${JSON.stringify(error.reasons, null, 2)}\n` +
          (available.length
            ? `  models this API key CAN use: ${available.join(", ")}`
            : "  (could not retrieve the list of usable models)")
      );
    }
    throw error;
  }
}

/** For the /api/ai/models diagnostics route. */
export async function aiDiagnostics() {
  return {
    promptVersion: PROMPT_VERSION,
    chains: { sql: SQL_MODEL_CHAIN, prose: PROSE_MODEL_CHAIN },
    thinking: { sql: SQL_THINKING, prose: PROSE_THINKING },
    timeouts: { sqlCallMs: SQL_CALL_TIMEOUT_MS, proseCallMs: PROSE_CALL_TIMEOUT_MS },
    health: modelHealth(),
    rateLimiter: rateLimiterStats(),
    availableModels: await listAvailableModels({ force: true }),
  };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

async function generateJson(
  chain: string[],
  prompt: string,
  label: string
): Promise<{ text: string; meta: CallMeta }> {
  /**
   * One attempt at the planner. `relief` is set on the retry after a
   * truncation: thinking is dialled down so the token budget goes to the answer
   * rather than to deliberation.
   */
  const attempt = async (relief: boolean) =>
    withModelDiagnostics(() =>
      callWithFallback(
        chain,
        async (model, ctx) => {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              maxOutputTokens: relief
                ? SQL_MAX_OUTPUT_TOKENS * 2
                : SQL_MAX_OUTPUT_TOKENS,
              thinkingConfig: {
                thinkingLevel: relief ? ThinkingLevel.MEDIUM : SQL_THINKING,
              },
              // The timeout comes from the caller's remaining time budget, not
              // a fixed constant — that is what makes the deadline enforceable
              // and lets a hedged loser be abandoned immediately.
              httpOptions: { timeout: ctx.timeoutMs },
              abortSignal: ctx.signal,
            },
          });

          // Same check the prose path has had. Its absence here is why a
          // truncated plan surfaced as a meaningless "unparseable response".
          const finish = response.candidates?.[0]?.finishReason;
          if (finish === "MAX_TOKENS") {
            const usage = response.usageMetadata;
            console.error(
              `[davis] ${label}: ${model} hit its output ceiling. ` +
                `thoughts=${usage?.thoughtsTokenCount ?? "?"} ` +
                `output=${usage?.candidatesTokenCount ?? "?"} ` +
                `ceiling=${relief ? SQL_MAX_OUTPUT_TOKENS * 2 : SQL_MAX_OUTPUT_TOKENS}. ` +
                "Thinking tokens count against this budget — raise " +
                "DAVIS_SQL_MAX_OUTPUT_TOKENS or lower DAVIS_SQL_THINKING_LEVEL."
            );
            throw new OutputTruncatedError(model);
          }

          const text = response.text;
          if (!text) throw new Error("Empty response from model.");
          return text;
        },
        { perCallCapMs: SQL_CALL_TIMEOUT_MS },
        label
      )
    );

  try {
    const { value, meta } = await attempt(false);
    return { text: value, meta };
  } catch (error: any) {
    if (!(error instanceof OutputTruncatedError)) throw error;
    console.warn(
      `[davis] ${label}: retrying once with a doubled output budget and ` +
        "medium thinking, so the tokens go to the plan instead of deliberation"
    );
    const { value, meta } = await attempt(true);
    return { text: value, meta };
  }
}

async function generateText(
  chain: string[],
  prompt: string,
  label: string
): Promise<{ text: string; meta: CallMeta }> {
  const { value, meta } = await withModelDiagnostics(() => callWithFallback(
    chain,
    async (model, ctx) => {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          // Room for a real table. Thinking tokens count against this too, so
          // the old 2048 was cutting long answers off mid-row.
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: PROSE_THINKING },
          httpOptions: { timeout: ctx.timeoutMs },
          abortSignal: ctx.signal,
        },
      });

      // A truncated answer is worse than no answer: it looks complete and is
      // not. Detect it and let the caller render the figures deterministically.
      const finish = response.candidates?.[0]?.finishReason;
      if (finish === "MAX_TOKENS") throw new OutputTruncatedError(model);

      const text = response.text;
      if (!text) throw new Error("Empty response from model.");
      return text;
    },
    { perCallCapMs: PROSE_CALL_TIMEOUT_MS },
    label
  ));

  return { text: value, meta };
}

/* -------------------------------------------------------------------------- */
/* JSON parsing                                                               */
/* -------------------------------------------------------------------------- */

import type { PlannerVisualization } from "@/lib/ai/visualize";

export type QueryIntent =
  | "DATA_QUERY"
  | "KNOWLEDGE_QUERY"
  | "HYBRID"
  | "RECALL_PREVIOUS_SQL"
  | "NEEDS_CLARIFICATION"
  | "NOT_DATA_RELATED";

export type AnswerShape = "SCALAR" | "SINGLE_ROW" | "ROW_SET" | "NONE";

export interface QueryPlan {
  intent: QueryIntent;
  plan: string;
  assumptions: string[];
  sql: string;
  answerShape: AnswerShape;
  clarifyingQuestion: string;
  /**
   * Concrete readings the user can pick from, rendered as buttons. A
   * clarifying question with no options makes the user type out what the
   * planner could have offered, which is most of the reason clarification
   * feels like an obstacle rather than a help.
   */
  clarifyingOptions: string[];
  selfCheck: string;
  /**
   * The chart the planner proposes. It is written before any row exists, so it
   * is a hypothesis: lib/ai/visualize.ts re-checks every field against the
   * result that actually came back and corrects what does not hold.
   */
  visualization: PlannerVisualization | null;
}

const CHART_TYPE_REQUESTS = [
  "auto",
  "none",
  "stat",
  "bar",
  "hbar",
  "line",
  "area",
  "pie",
  "scatter",
] as const;

/**
 * The model is asked for a specific object shape and mostly obliges, but a
 * malformed chart suggestion must never cost the user their answer — the SQL
 * ran and the figures are verified either way. Anything unparseable degrades
 * to null, which means "choose the chart from the data alone".
 */
function normaliseVisualization(raw: any): PlannerVisualization | null {
  if (!raw || typeof raw !== "object") return null;

  const type = String(raw.type || "auto").toLowerCase().trim();
  const y = Array.isArray(raw.y)
    ? raw.y.map((v: any) => String(v || "").trim()).filter(Boolean)
    : typeof raw.y === "string" && raw.y.trim()
    ? [raw.y.trim()]
    : [];

  return {
    type: (CHART_TYPE_REQUESTS as readonly string[]).includes(type)
      ? (type as PlannerVisualization["type"])
      : "auto",
    x: String(raw.x || "").trim(),
    y,
    series: String(raw.series || "").trim(),
    stacked: raw.stacked === true || String(raw.stacked).toLowerCase() === "true",
    title: String(raw.title || "").trim(),
    reason: String(raw.reason || "").trim(),
  };
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

export function extractJsonObject(text: string): any | null {
  const t = stripFences(text);
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

function cleanSql(sql: string): string {
  let s = stripFences(String(sql || "")).trim();
  if (s.toLowerCase().startsWith("sql\n")) s = s.slice(4);
  return s.replace(/;\s*$/, "").trim();
}

export function normalisePlan(parsed: any, rawText: string): QueryPlan {
  if (!parsed) {
    const bare = stripFences(rawText).trim();
    if (/^(select|with)\b/i.test(bare)) {
      return {
        intent: "DATA_QUERY",
        plan: "(model returned bare SQL instead of the JSON contract)",
        assumptions: [],
        sql: cleanSql(bare),
        answerShape: "ROW_SET",
        clarifyingQuestion: "",
        clarifyingOptions: [],
        selfCheck: "",
        visualization: null,
      };
    }
    // Never throw an unfalsifiable error again. Show the evidence.
    const preview = String(rawText || "").slice(0, 1200);
    const looksTruncated =
      preview.trimEnd().length > 0 &&
      !preview.trimEnd().endsWith("}") &&
      preview.includes("{");
    console.error(
      `[davis] planner returned unparseable output (${
        String(rawText || "").length
      } chars${looksTruncated ? ", appears CUT OFF mid-JSON" : ""}). ` +
        `First 1200 chars:\n${preview}`
    );
    throw new Error(
      "The query planner returned a response DAVIS could not parse as JSON" +
        (looksTruncated
          ? " — it appears to have been cut off mid-object, which usually means " +
            "the output token budget ran out. Raise DAVIS_SQL_MAX_OUTPUT_TOKENS " +
            "or lower DAVIS_SQL_THINKING_LEVEL."
          : ". The full response is in the server log.")
    );
  }

  const validIntents: QueryIntent[] = [
    "DATA_QUERY",
    "KNOWLEDGE_QUERY",
    "HYBRID",
    "RECALL_PREVIOUS_SQL",
    "NEEDS_CLARIFICATION",
    "NOT_DATA_RELATED",
  ];
  const intent = String(parsed.intent || "DATA_QUERY").toUpperCase() as QueryIntent;

  return {
    intent: validIntents.includes(intent) ? intent : "DATA_QUERY",
    plan: String(parsed.plan || ""),
    assumptions: Array.isArray(parsed.assumptions)
      ? parsed.assumptions.map((a: any) => String(a)).filter(Boolean)
      : [],
    sql: cleanSql(parsed.sql || ""),
    answerShape: (["SCALAR", "SINGLE_ROW", "ROW_SET", "NONE"].includes(
      String(parsed.answer_shape || "").toUpperCase()
    )
      ? String(parsed.answer_shape).toUpperCase()
      : "ROW_SET") as AnswerShape,
    clarifyingQuestion: String(parsed.clarifying_question || ""),
    // Capped at four: past that the buttons wrap into a wall and picking one
    // stops being faster than typing the answer.
    clarifyingOptions: Array.isArray(parsed.clarifying_options)
      ? parsed.clarifying_options
          .map((o: any) => String(o || "").trim())
          .filter(Boolean)
          .slice(0, 4)
      : [],
    selfCheck: String(parsed.self_check || ""),
    visualization: normaliseVisualization(parsed.visualization),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface PlanQueryParams {
  question: string;
  schemaDoc: string;
  dialect: string;
  chatHistory?: string;
  todayISO?: string;
}

export async function planQuery(
  params: PlanQueryParams
): Promise<{ plan: QueryPlan; meta: CallMeta }> {
  const prompt = buildSqlPrompt({
    question: params.question,
    schemaDoc: params.schemaDoc,
    dialect: params.dialect,
    chatHistory: params.chatHistory,
    todayISO: params.todayISO || new Date().toISOString().slice(0, 10),
  });

  const { text, meta } = await generateJson(SQL_MODEL_CHAIN, prompt, "plan query");
  return { plan: normalisePlan(extractJsonObject(text), text), meta };
}

export interface RepairQueryParams {
  question: string;
  schemaDoc: string;
  dialect: string;
  failedSql: string;
  errorMessage: string;
  previousPlan?: string;
  attempt: number;
}

export async function repairQuery(
  params: RepairQueryParams
): Promise<{ plan: QueryPlan; meta: CallMeta }> {
  const prompt = buildRepairPrompt(params);
  const { text, meta } = await generateJson(
    SQL_MODEL_CHAIN,
    prompt,
    `repair query (attempt ${params.attempt})`
  );
  return { plan: normalisePlan(extractJsonObject(text), text), meta };
}

export interface GenerateAnswerParams {
  question: string;
  sql: string;
  factSheet: string;
  dataPreview: string;
  rowCount: number;
  totalRowCount?: number | null;
  truncated: boolean;
  answerShape: string;
  assumptions: string[];
  chatHistory?: string;
  /** What is on screen beside the answer, so the model does not deny it. */
  chart?: AnswerChartContext | null;
}

export async function generateConversationalAnswer(
  params: GenerateAnswerParams
): Promise<{ answer: string; meta: CallMeta }> {
  const prompt = buildAnswerPrompt(params);
  const { text, meta } = await generateText(
    PROSE_MODEL_CHAIN,
    prompt,
    "render answer"
  );
  return { answer: text.trim(), meta };
}

export async function generateNonDataReply(params: {
  question: string;
  chatHistory?: string;
  connectionName: string;
}): Promise<{ answer: string; meta: CallMeta }> {
  const prompt = buildNonDataPrompt(params);
  const { text, meta } = await generateText(
    PROSE_MODEL_CHAIN,
    prompt,
    "non-data reply"
  );
  return { answer: text.trim(), meta };
}

/**
 * Answer from documented knowledge.
 *
 * Runs on the PROSE chain, not the SQL chain. The work here is faithful
 * reproduction of source material, not multi-step reasoning — and the prose
 * chain is the cheaper, higher-capacity tier, which is what the sub-five-second
 * target for this path depends on.
 */
export async function generateKnowledgeAnswer(
  params: KnowledgePromptInput
): Promise<{ answer: string; meta: CallMeta }> {
  const prompt = buildKnowledgePrompt(params);
  const { text, meta } = await generateText(
    PROSE_MODEL_CHAIN,
    prompt,
    "answer from knowledge"
  );
  return { answer: text.trim(), meta };
}
