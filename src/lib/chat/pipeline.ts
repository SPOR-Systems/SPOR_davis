import { prisma } from "@/lib/prisma";
import {
  AI_CONFIG,
  generateConversationalAnswer,
  generateNonDataReply,
  OutputTruncatedError,
  planQuery,
  repairQuery,
  type QueryPlan,
} from "@/lib/ai/gemini";
import {
  LocalTimeoutError,
  ModelConfigurationError,
  ProviderOverloadedError,
  QuotaExceededError,
  isLowQuota,
  lastQuota,
  describeQuota,
  limiterStats,
  rateLimiterStats,
  type CallMeta,
} from "@/lib/ai/resilience";
import { getCachedPlan, planCacheKey, setCachedPlan } from "@/lib/ai/planCache";
import {
  countRows,
  executeQuery,
  validateQuery,
  type QueryResult,
} from "@/lib/db/queryRunner";
import { getSchemaContext, renderSchemaForPrompt } from "@/lib/db/schemaContext";
import {
  buildDataPreview,
  buildFactSheet,
  renderDeterministicAnswer,
} from "@/lib/ai/facts";
import { dialectLabel } from "@/lib/db/connection";
import {
  buildChartPayload,
  resolveChartSpec,
  CHART_TYPE_PROSE,
  type ChartPayload,
  type ChartSpec,
} from "@/lib/ai/visualize";
import type { AnswerChartContext } from "@/lib/ai/prompts";

/**
 * ============================================================================
 *  CHAT PIPELINE
 * ============================================================================
 *  One implementation, two delivery modes. The route can either await this and
 *  return a single JSON body, or stream the stage events as they happen. That
 *  matters because the error handling in here — quota vs overload vs local
 *  timeout vs config — was expensive to get right and must not be duplicated.
 *
 *  PROGRESS REPORTING
 *  ------------------
 *  Every stage emitted below corresponds to work that is actually happening,
 *  and every `detail` is a measured fact: real table counts, the model that
 *  actually served the call, real row counts, the real database error when a
 *  query needs repairing. Nothing here is decorative. A progress indicator that
 *  invents plausible-sounding activity is worse than a spinner, because it
 *  teaches the user to distrust everything else the app says.
 * ============================================================================
 */

export type StageId =
  | "schema"
  | "history"
  | "plan"
  | "validate"
  | "repair"
  | "execute"
  | "count"
  | "answer";

export interface TraceEntry {
  id: StageId;
  label: string;
  detail?: string;
  ms: number;
}

export type StreamEvent =
  | { t: "stage"; id: StageId; label: string }
  | { t: "stage_end"; id: StageId; detail?: string; ms: number }
  | { t: "done"; status: number; body: any }
  | { t: "error"; status: number; body: any };

export type Emit = (event: StreamEvent) => void;

export interface PipelineOutcome {
  status: number;
  body: any;
  headers?: Record<string, string>;
}

export interface PipelineUser {
  userId: string;
  organizationId: string;
}

const MAX_REPAIR_ATTEMPTS = Number(process.env.DAVIS_MAX_REPAIRS || 2);
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS_PER_MESSAGE = 600;

interface AttemptLog {
  attempt: number;
  sql: string;
  stage: "validate" | "execute";
  error: string;
}

/** Compact "3h ago" style age, for the schema-cache detail line. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function runChatPipeline(args: {
  user: PipelineUser;
  body: any;
  emit?: Emit;
}): Promise<PipelineOutcome> {
  const { user, body } = args;
  const startedAt = Date.now();
  const trace: TraceEntry[] = [];

  const emit: Emit = args.emit || (() => {});

  /** Wrap a step so it announces itself, times itself, and records the trace. */
  const step = async <T>(
    id: StageId,
    label: string,
    fn: () => Promise<T>,
    describe?: (value: T) => string | undefined
  ): Promise<T> => {
    emit({ t: "stage", id, label });
    const t0 = Date.now();
    try {
      const value = await fn();
      const ms = Date.now() - t0;
      const detail = describe ? describe(value) : undefined;
      trace.push({ id, label, detail, ms });
      emit({ t: "stage_end", id, detail, ms });
      return value;
    } catch (error) {
      const ms = Date.now() - t0;
      const detail = `failed: ${String((error as any)?.message || error).slice(0, 160)}`;
      trace.push({ id, label, detail, ms });
      emit({ t: "stage_end", id, detail, ms });
      throw error;
    }
  };

  try {
    const { question, connectionId, sessionId, refreshSchema } = body || {};

    if (!question || !connectionId) {
      return {
        status: 400,
        body: { error: "Question and connectionId are required", code: "BAD_REQUEST" },
      };
    }

    const conn = await prisma.databaseConnection.findFirst({
      where: { id: connectionId, organizationId: user.organizationId },
    });
    if (!conn) {
      return {
        status: 404,
        body: { error: "Database connection not found", code: "NO_CONNECTION" },
      };
    }

    const dialect = dialectLabel(conn.type);

    /* ---------------------------------------------------------------------- */
    /* 1. Schema context (cached; profiled from the live database)            */
    /* ---------------------------------------------------------------------- */
    const schemaCtx = await step(
      "schema",
      "Reading the database schema",
      () =>
        getSchemaContext(connectionId, user.organizationId, {
          forceRefresh: Boolean(refreshSchema),
        }),
      (ctx) => {
        const valueLists = ctx.tables.reduce(
          (n, t) => n + t.columns.filter((c) => c.enumValues?.length).length,
          0
        );
        return (
          `${ctx.tables.length} tables · ${ctx.foreignKeys.length} join paths · ` +
          `${valueLists} value lists · profiled ${ago(ctx.generatedAt)}`
        );
      }
    );
    const schemaDoc = renderSchemaForPrompt(schemaCtx);

    /* ---------------------------------------------------------------------- */
    /* 2. Chat history                                                        */
    /* ---------------------------------------------------------------------- */
    const chatHistory = await buildChatHistory(sessionId);

    /* ---------------------------------------------------------------------- */
    /* 3. Plan — from cache when we have planned this exact question before   */
    /* ---------------------------------------------------------------------- */
    const todayISO = new Date().toISOString().slice(0, 10);

    const cacheKey = planCacheKey({
      connectionId,
      schemaGeneratedAt: schemaCtx.generatedAt,
      question,
      chatHistory,
      // Date literals get baked into the generated SQL, so a plan is only
      // reusable on the day it was made.
      todayISO,
    });

    let plan: QueryPlan;
    let planMeta: CallMeta | null = null;
    let planFromCache = false;

    const cached = getCachedPlan(cacheKey);
    if (cached) {
      plan = cached;
      planFromCache = true;
      trace.push({
        id: "plan",
        label: "Planning the query",
        detail: "reused a plan from earlier — the query still runs fresh",
        ms: 0,
      });
      emit({ t: "stage", id: "plan", label: "Planning the query" });
      emit({
        t: "stage_end",
        id: "plan",
        detail: "reused a plan from earlier — the query still runs fresh",
        ms: 0,
      });
    } else {
      const planned = await step(
        "plan",
        "Planning the query",
        () =>
          planQuery({ question, schemaDoc, dialect, chatHistory, todayISO }),
        (p) =>
          `${p.meta.modelUsed}${p.meta.degraded ? " (fallback)" : ""}` +
          `${p.meta.hedged ? " · hedged" : ""}`
      );
      plan = planned.plan;
      planMeta = planned.meta;
    }

    const modelInfo = () => ({
      planFromCache,
      sqlModelUsed: planMeta?.modelUsed ?? "cache",
      sqlModelDegraded: planMeta?.degraded ?? false,
      providerWaitedMs: planMeta?.waitedMs ?? 0,
      concurrency: limiterStats(),
    });

    /* ---------------------------------------------------------------------- */
    /* 4. Route on intent                                                     */
    /* ---------------------------------------------------------------------- */

    if (plan.intent === "NOT_DATA_RELATED") {
      const { answer, meta } = await step(
        "answer",
        "Writing a reply",
        () =>
          generateNonDataReply({
            question,
            chatHistory,
            connectionName: conn.name,
          }),
        (r) => r.meta.modelUsed
      );
      return await persist({
        question,
        answer,
        sessionId,
        user,
        connectionId,
        trace,
        extra: { degraded: meta.degraded },
        metadata: {
          status: "no_query",
          intent: plan.intent,
          ...modelInfo(),
          proseModelUsed: meta.modelUsed,
          promptVersion: AI_CONFIG.promptVersion,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    if (
      plan.intent === "NEEDS_CLARIFICATION" ||
      (plan.intent === "DATA_QUERY" && !plan.sql)
    ) {
      const ask =
        plan.clarifyingQuestion ||
        "I want to make sure I give you the right number. Could you tell me a bit more precisely what you'd like measured?";
      return await persist({
        question,
        answer: ask,
        sessionId,
        user,
        connectionId,
        trace,
        extra: { clarifyingOptions: plan.clarifyingOptions },
        metadata: {
          status: "clarification_requested",
          intent: plan.intent,
          plan: plan.plan,
          clarifyingOptions: plan.clarifyingOptions,
          ...modelInfo(),
          promptVersion: AI_CONFIG.promptVersion,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    if (plan.intent === "RECALL_PREVIOUS_SQL") {
      const answer = plan.sql
        ? `Here's the query I ran for that answer:\n\n\`\`\`sql\n${plan.sql}\n\`\`\``
        : "I don't have a previous query in this conversation to show you yet.";
      return await persist({
        question,
        answer,
        sessionId,
        user,
        connectionId,
        trace,
        metadata: {
          status: "recall",
          intent: plan.intent,
          sql: plan.sql,
          ...modelInfo(),
          promptVersion: AI_CONFIG.promptVersion,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    /* ---------------------------------------------------------------------- */
    /* 5. Validate -> execute -> repair loop                                  */
    /* ---------------------------------------------------------------------- */
    const attempts: AttemptLog[] = [];
    let result: QueryResult | null = null;
    let attempt = 0;

    while (attempt <= MAX_REPAIR_ATTEMPTS) {
      const validation = await step(
        "validate",
        "Checking the query against the database",
        () => validateQuery(connectionId, user.organizationId, plan.sql),
        (v) => (v.valid ? "valid" : `rejected: ${(v.error || "").slice(0, 120)}`)
      );

      if (!validation.valid) {
        attempts.push({
          attempt: attempt + 1,
          sql: plan.sql,
          stage: "validate",
          error: validation.error || "unknown validation error",
        });

        if (attempt === MAX_REPAIR_ATTEMPTS) break;

        const repaired = await step(
          "repair",
          `Fixing the query (attempt ${attempt + 2})`,
          () =>
            repairQuery({
              question,
              schemaDoc,
              dialect,
              failedSql: plan.sql,
              errorMessage: validation.error || "unknown validation error",
              previousPlan: plan.plan,
              attempt: attempt + 2,
            }),
          (r) => r.meta.modelUsed
        );
        plan = mergeAssumptions(plan, repaired.plan);
        planMeta = repaired.meta;
        planFromCache = false;

        if (plan.intent === "NEEDS_CLARIFICATION" || !plan.sql) {
          return await persist({
            question,
            answer:
              plan.clarifyingQuestion ||
              "I couldn't map that question onto the data reliably. Could you rephrase which figure you need?",
            sessionId,
            user,
            connectionId,
            trace,
            extra: { clarifyingOptions: plan.clarifyingOptions },
            metadata: {
              status: "clarification_requested",
              intent: plan.intent,
              clarifyingOptions: plan.clarifyingOptions,
              attempts,
              ...modelInfo(),
              promptVersion: AI_CONFIG.promptVersion,
              latencyMs: Date.now() - startedAt,
            },
          });
        }

        attempt++;
        continue;
      }

      const executed = await step(
        "execute",
        "Running the query",
        () => executeQuery(connectionId, user.organizationId, plan.sql),
        (r) =>
          r.error
            ? `failed: ${r.error.slice(0, 120)}`
            : `${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${
                r.truncated ? " (capped)" : ""
              }`
      );

      if (!executed.error) {
        result = executed;
        break;
      }

      attempts.push({
        attempt: attempt + 1,
        sql: plan.sql,
        stage: "execute",
        error: executed.error,
      });

      if (attempt === MAX_REPAIR_ATTEMPTS) break;

      const repaired = await step(
        "repair",
        `Fixing the query (attempt ${attempt + 2})`,
        () =>
          repairQuery({
            question,
            schemaDoc,
            dialect,
            failedSql: plan.sql,
            errorMessage: executed.error!,
            previousPlan: plan.plan,
            attempt: attempt + 2,
          }),
        (r) => r.meta.modelUsed
      );
      plan = mergeAssumptions(plan, repaired.plan);
      planMeta = repaired.meta;
      planFromCache = false;

      if (plan.intent === "NEEDS_CLARIFICATION" || !plan.sql) break;
      attempt++;
    }

    if (!result) {
      const lastError = attempts[attempts.length - 1]?.error || "unknown error";
      return await persist({
        question,
        answer:
          "I wasn't able to build a query I trust for that question, so I'd rather not " +
          "give you a number I can't stand behind. Could you rephrase it, or tell me which " +
          "specific figures and filters you're after?",
        sessionId,
        user,
        connectionId,
        trace,
        extra: { code: "QUERY_FAILED", lastError },
        metadata: {
          status: "failed",
          intent: plan.intent,
          attempts,
          lastError,
          ...modelInfo(),
          promptVersion: AI_CONFIG.promptVersion,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    // The plan worked. Cache it so a repeat of this question skips planning
    // entirely — the SQL still re-executes, so the numbers stay live.
    setCachedPlan(cacheKey, plan);

    /* ---------------------------------------------------------------------- */
    /* 6. True total when the row cap kicked in                               */
    /* ---------------------------------------------------------------------- */
    let totalRowCount: number | null = null;
    if (result.truncated) {
      totalRowCount = await step(
        "count",
        "Counting the full result set",
        () => countRows(connectionId, user.organizationId, plan.sql),
        (n) => (n === null ? "unavailable" : `${n.toLocaleString()} rows match`)
      );
    }

    /* ---------------------------------------------------------------------- */
    /* 7. Deterministic figures, then prose                                   */
    /* ---------------------------------------------------------------------- */
    const factSheet = buildFactSheet({
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      totalRowCount,
      answerShape: plan.answerShape,
    });

    /* ---------------------------------------------------------------------- */
    /* 7b. The chart — the planner's proposal, checked against the real result */
    /* ---------------------------------------------------------------------- */
    // Deliberately not a model call. The planner already named a chart in the
    // same request that wrote the SQL, and this step only verifies that the
    // named columns exist, hold what the chart needs, and can honestly share an
    // axis. A third provider request per question would fight the low-quota
    // degradation the rest of this pipeline is built around.
    let chart: ChartPayload | null = null;
    let chartSpec: ChartSpec | null = null;
    try {
      chartSpec = resolveChartSpec({
        suggestion: plan.visualization,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        answerShape: plan.answerShape,
      });
      chart =
        chartSpec.type === "none"
          ? null
          : buildChartPayload({
              spec: chartSpec,
              // The full result, not the 200-row sample the response carries.
              rows: result.rows,
              truncated: result.truncated,
            });
    } catch (error: any) {
      // The figures are already verified; a chart is an addition to the answer,
      // never a precondition for it.
      console.warn("[davis] chart selection failed:", error?.message || error);
      chart = null;
      chartSpec = null;
    }

    // The answer writer cannot see the page it is writing into. Told nothing,
    // it falls back on "I am a text-based assistant" and denies the chart that
    // is rendering directly beneath its own sentence — so it is told, including
    // when the form it renders is not the one the user asked for.
    const chartContext: AnswerChartContext | null = chartSpec
      ? {
          rendered: chart !== null,
          typeLabel: CHART_TYPE_PROSE[chartSpec.type],
          title: chartSpec.title,
          reason: chartSpec.reason,
          corrected: chartSpec.source === "planner-corrected",
        }
      : null;

    let answer: string;
    let proseMeta: CallMeta | null = null;
    let proseUnavailable = false;
    let answerTruncated = false;
    let proseSkippedForQuota = false;

    // Every question costs one request to plan. The prose call is a second one
    // that only rewrites figures already computed in code — so when quota is
    // the binding constraint it is the first thing to drop.
    if (isLowQuota()) {
      proseSkippedForQuota = true;
      emit({ t: "stage", id: "answer", label: "Rendering the verified figures" });
      answer = renderDeterministicAnswer({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        totalRowCount,
        reason: "low_quota",
      });
      const detail = "written summary skipped to conserve API quota";
      trace.push({ id: "answer", label: "Rendering the verified figures", detail, ms: 0 });
      emit({ t: "stage_end", id: "answer", detail, ms: 0 });
      console.warn(
        "[davis] low-quota mode: skipping the prose call and rendering the " +
          "verified figures directly (1 provider request instead of 2)"
      );
    } else {
      try {
        const rendered = await step(
          "answer",
          "Writing the answer",
          () =>
            generateConversationalAnswer({
              question,
              sql: plan.sql,
              factSheet,
              dataPreview: buildDataPreview(result!.columns, result!.rows),
              rowCount: result!.rowCount,
              totalRowCount,
              truncated: result!.truncated,
              answerShape: plan.answerShape,
              assumptions: plan.assumptions,
              chatHistory,
              chart: chartContext,
            }),
          (r) => `${r.meta.modelUsed}${r.meta.degraded ? " (fallback)" : ""}`
        );
        answer = rendered.answer;
        proseMeta = rendered.meta;
      } catch (error: any) {
        // The query already ran and the figures are already verified. Losing
        // the sentence-writer is no reason to lose the answer.
        if (
          error instanceof ProviderOverloadedError ||
          error instanceof QuotaExceededError ||
          error instanceof ModelConfigurationError ||
          error instanceof LocalTimeoutError ||
          error instanceof OutputTruncatedError
        ) {
          answerTruncated = error instanceof OutputTruncatedError;
          proseUnavailable = !answerTruncated;
          console.warn(
            answerTruncated
              ? "[davis] prose answer hit the output limit — rendering the " +
                  "result deterministically instead of a half-written table"
              : "[davis] prose model unavailable — rendering the verified " +
                  "figures directly"
          );
          answer = renderDeterministicAnswer({
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            totalRowCount,
            reason: answerTruncated ? "answer_too_long" : "model_unavailable",
          });
        } else {
          throw error;
        }
      }
    }

    return await persist({
      question,
      answer,
      sessionId,
      user,
      connectionId,
      trace,
      extra: {
        sql: plan.sql,
        assumptions: plan.assumptions,
        columns: result.columns,
        rows: result.rows.slice(0, 200),
        rowCount: result.rowCount,
        totalRowCount,
        truncated: result.truncated,
        chart,
        degraded: Boolean(planMeta?.degraded || proseMeta?.degraded),
        proseUnavailable,
        answerTruncated,
        proseSkippedForQuota,
      },
      metadata: {
        status: "success",
        intent: plan.intent,
        sql: plan.sql,
        executedSql: result.executedSql,
        plan: plan.plan,
        selfCheck: plan.selfCheck,
        assumptions: plan.assumptions,
        answerShape: plan.answerShape,
        chart,
        rowCount: result.rowCount,
        totalRowCount,
        truncated: result.truncated,
        repairAttempts: attempts,
        ...modelInfo(),
        proseModelUsed:
          proseMeta?.modelUsed ?? (proseUnavailable ? "none" : "unknown"),
        proseUnavailable,
        answerTruncated,
        proseSkippedForQuota,
        lowQuotaMode: isLowQuota(),
        rateLimiter: rateLimiterStats(),
        hedged: Boolean(planMeta?.hedged || proseMeta?.hedged),
        promptVersion: AI_CONFIG.promptVersion,
        schemaProfiledAt: schemaCtx.generatedAt,
        latencyMs: Date.now() - startedAt,
      },
    });
  } catch (error: any) {
    /* ---------------------------------------------------------------------- */
    /* Honest error reporting — these are not the same problem               */
    /* ---------------------------------------------------------------------- */

    if (error instanceof QuotaExceededError) {
      const violation = lastQuota();
      console.error("[davis] quota exceeded:", error.message);
      return {
        status: 429,
        headers: error.retryAfterMs
          ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) }
          : undefined,
        body: {
          error: error.message,
          code: "QUOTA_EXCEEDED",
          quotaExplanation: describeQuota(violation),
          freeTier: Boolean(violation?.freeTier),
          retryAfterMs: error.retryAfterMs ?? null,
          trace,
        },
      };
    }

    if (error instanceof ModelConfigurationError) {
      console.error("[davis] model configuration error:", error.message);
      return {
        status: 500,
        body: {
          error:
            "DAVIS is not configured with a usable model. None of the models in " +
            "the configured chain can be reached with this API key — check the " +
            "server logs for the list of models the key can actually use.",
          code: "MODEL_CONFIGURATION",
          modelsTried: error.modelsTried,
          trace,
        },
      };
    }

    if (error instanceof LocalTimeoutError) {
      console.error("[davis] local timeout:", error.message);
      return {
        status: 504,
        body: {
          error:
            "DAVIS stopped waiting before the model answered. This is DAVIS's own " +
            "timeout, not an error from Google — the model may simply need longer " +
            "to think. Raising DAVIS_SQL_CALL_TIMEOUT_MS, or setting " +
            "DAVIS_SQL_THINKING_LEVEL=medium, should fix it.",
          code: "LOCAL_TIMEOUT",
          timeoutMs: error.timeoutMs,
          trace,
        },
      };
    }

    if (error instanceof ProviderOverloadedError) {
      console.warn("[davis] provider overloaded:", error.message);
      return {
        status: 503,
        body: {
          error:
            "Google's models are overloaded right now. Nothing is wrong with your question — it's worth trying again in a moment.",
          code: "PROVIDER_OVERLOADED",
          modelsTried: error.modelsTried,
          retryAfterMs: error.retryAfterMs ?? null,
          trace,
        },
      };
    }

    console.error("[davis] Generate Chat API Error:", error);
    return {
      status: 500,
      body: {
        error: error?.message || "Failed to answer the question",
        code: "INTERNAL_ERROR",
        trace,
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A repair must not quietly drop what the original plan established.
 *
 * Assumptions are unioned rather than replaced: the repair addressed a database
 * error, it did not revisit the interpretation. The chart suggestion is kept
 * only when the repair did not supply its own — a repair that renamed an alias
 * is expected to restate the chart against the new names (rule R6), and its
 * version is the one that matches the SQL that will actually run.
 */
function mergeAssumptions(previous: QueryPlan, repaired: QueryPlan): QueryPlan {
  const merged = new Set([...previous.assumptions, ...repaired.assumptions]);
  return {
    ...repaired,
    assumptions: [...merged],
    visualization: repaired.visualization ?? previous.visualization,
  };
}

async function buildChatHistory(sessionId?: string): Promise<string> {
  if (!sessionId) return "";

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_MESSAGES,
  });

  if (messages.length === 0) return "";

  return messages
    .reverse()
    .map((m: { role: string; content: string; metadata: string | null }) => {
      const content =
        m.content.length > HISTORY_CHARS_PER_MESSAGE
          ? m.content.slice(0, HISTORY_CHARS_PER_MESSAGE) + " ...[truncated]"
          : m.content;

      let text = `${m.role}: ${content}`;

      if (m.role === "ASSISTANT" && m.metadata) {
        try {
          const meta = JSON.parse(m.metadata as string);
          if (meta.sql) text += `\n[Previously Executed SQL: ${meta.sql}]`;
          if (Array.isArray(meta.assumptions) && meta.assumptions.length) {
            text += `\n[Assumptions: ${meta.assumptions.join("; ")}]`;
          }
        } catch {
          /* ignore malformed metadata */
        }
      }
      return text;
    })
    .join("\n\n");
}

async function persist(args: {
  question: string;
  answer: string;
  sessionId?: string;
  user: PipelineUser;
  connectionId: string;
  trace: TraceEntry[];
  metadata: Record<string, any>;
  extra?: Record<string, any>;
}): Promise<PipelineOutcome> {
  const { question, answer, user, connectionId, metadata, extra, trace } = args;

  let actualSessionId = args.sessionId;
  if (!actualSessionId) {
    const session = await prisma.chatSession.create({
      data: {
        title: question.slice(0, 60),
        userId: user.userId,
        organizationId: user.organizationId,
      },
    });
    actualSessionId = session.id;
  }

  await prisma.chatMessage.create({
    data: {
      sessionId: actualSessionId,
      role: "USER",
      content: question,
      connectionId,
    },
  });

  const assistantMsg = await prisma.chatMessage.create({
    data: {
      sessionId: actualSessionId,
      role: "ASSISTANT",
      content: answer,
      connectionId,
      // The trace is stored, not just streamed: it survives a reload and
      // doubles as the record of what DAVIS actually did when an answer looks
      // wrong later.
      metadata: JSON.stringify({ ...metadata, trace }),
    },
  });

  return {
    status: 200,
    body: {
      sessionId: actualSessionId,
      messageId: assistantMsg.id,
      message: assistantMsg.content,
      status: metadata.status,
      trace,
      ...(extra || {}),
    },
  };
}
