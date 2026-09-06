import type { SchemaContext } from "@/lib/db/schemaContext";
import { retrieve, STRONG_RELEVANCE, type RetrievalResult } from "@/lib/knowledge/retrieve";

/**
 * ============================================================================
 *  PRE-ROUTER
 * ============================================================================
 *  Decides, before any planning happens, whether a question is plainly about
 *  documented knowledge rather than about data.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Routing through the planner costs a model call carrying the entire schema
 *  document — 20 to 40 seconds. For "how do I issue a refund" that is 20 to 40
 *  seconds spent discovering the question was never about data. An analyst can
 *  wait; someone with a customer on the line cannot, and an answer that arrives
 *  after the call ended is not an answer.
 *
 *  One embedding call is ~100ms, on a quota bucket the planner is not
 *  competing for. So the question gets embedded once and the vectors decide.
 *
 *  THE ASYMMETRY THAT MAKES THIS SAFE
 *  ----------------------------------
 *  The two mistakes are not equally bad:
 *
 *    Wrongly taking the fast path  -> a data question answered from documents.
 *                                     A stale figure presented as current. This
 *                                     is the failure the governing rule exists
 *                                     to prevent.
 *    Wrongly taking the slow path  -> a knowledge question waits 30 seconds and
 *                                     then gets answered correctly anyway,
 *                                     because the planner can still return
 *                                     KNOWLEDGE_QUERY.
 *
 *  The first is a correctness failure; the second is a latency failure. So
 *  every ambiguous case resolves to the planner, and the fast path fires only
 *  on a clear, unopposed signal.
 * ============================================================================
 */

export type Route = "KNOWLEDGE_FAST_PATH" | "PLANNER";

export interface RouteDecision {
  route: Route;
  reason: string;
  /** Carried forward so the knowledge path does not re-run retrieval. */
  retrieval?: RetrievalResult;
  schemaOverlap: string[];
  topScore: number;
}

/**
 * Words that appear in a schema and in ordinary English alike. Matching on
 * these would make almost every question look like a data question.
 */
const STOPWORDS = new Set([
  "id", "name", "type", "date", "time", "status", "code", "value", "text",
  "number", "count", "total", "amount", "data", "table", "record", "records",
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "by", "is", "are",
  "how", "what", "when", "where", "who", "why", "do", "does", "did", "i", "we",
  "can", "should", "would", "my", "our", "and", "or", "not", "with",
]);

function tokenize(text: string): string[] {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Which schema identifiers the question actually names.
 *
 * Whole-token matching against table and column names, split on the same word
 * boundaries the schema uses. "customers" matching TBL_CUST_ACCT_01 is not
 * detectable this way and is not meant to be — this is a check for an
 * UNAMBIGUOUS data signal, not a synonym engine. Missing one sends the
 * question to the planner, which is the safe direction.
 */
export function schemaOverlap(question: string, schema: SchemaContext): string[] {
  const asked = new Set(tokenize(question));
  if (asked.size === 0) return [];

  const hits = new Set<string>();

  for (const table of schema.tables) {
    for (const token of tokenize(table.name)) {
      if (asked.has(token)) hits.add(table.name);
    }
    for (const column of table.columns) {
      for (const token of tokenize(column.name)) {
        if (asked.has(token)) hits.add(`${table.name}.${column.name}`);
      }
    }
  }

  return [...hits];
}

/**
 * Phrasings that are asking how to DO something rather than what the data
 * says. "How do I", "what is the process for", "where do I find".
 *
 * A supporting signal only — it can raise confidence in a knowledge route but
 * never creates one on its own, because "how do I count orders over 500" is
 * procedural-sounding and squarely a data question.
 */
const PROCEDURAL_PHRASING =
  /\b(how (?:do|does|can) (?:i|we|you)|what(?:'s| is) the (?:process|procedure|workflow|policy)|steps? (?:to|for)|where (?:do|can) (?:i|we)|am i (?:allowed|supposed)|walk me through)\b/i;

export async function decideRoute(args: {
  question: string;
  knowledgeBaseId: string | null;
  schema: SchemaContext | null;
}): Promise<RouteDecision> {
  const { question, knowledgeBaseId, schema } = args;

  const overlap = schema ? schemaOverlap(question, schema) : [];

  if (!knowledgeBaseId) {
    return {
      route: "PLANNER",
      reason: "no knowledge base exists yet",
      schemaOverlap: overlap,
      topScore: 0,
    };
  }

  // The question names something in the schema. Even with a strong knowledge
  // match this goes to the planner: a question that touches data must have the
  // chance to be answered from data.
  if (overlap.length > 0) {
    return {
      route: "PLANNER",
      reason: `the question names ${overlap.slice(0, 3).join(", ")} in the schema`,
      schemaOverlap: overlap,
      topScore: 0,
    };
  }

  let retrieval: RetrievalResult;
  try {
    retrieval = await retrieve({ question, knowledgeBaseId });
  } catch (error: any) {
    // Retrieval is an optimisation here. If it breaks, the planner still works.
    return {
      route: "PLANNER",
      reason: `knowledge search unavailable (${error?.message || error})`,
      schemaOverlap: overlap,
      topScore: 0,
    };
  }

  if (retrieval.unavailable) {
    return {
      route: "PLANNER",
      reason: retrieval.unavailable,
      schemaOverlap: overlap,
      topScore: 0,
      retrieval,
    };
  }

  const procedural = PROCEDURAL_PHRASING.test(question);
  // Procedural phrasing lowers the bar a little, but never below the point
  // where a match is meaningful.
  const threshold = procedural ? STRONG_RELEVANCE - 0.05 : STRONG_RELEVANCE;

  if (retrieval.topScore >= threshold) {
    return {
      route: "KNOWLEDGE_FAST_PATH",
      reason:
        `documented knowledge matches strongly (${retrieval.topScore.toFixed(2)}) ` +
        `and the question names nothing in the database`,
      schemaOverlap: overlap,
      topScore: retrieval.topScore,
      retrieval,
    };
  }

  return {
    route: "PLANNER",
    reason:
      retrieval.topScore > 0
        ? `knowledge match too weak to skip planning (${retrieval.topScore.toFixed(2)})`
        : "nothing in the knowledge base matches",
    schemaOverlap: overlap,
    topScore: retrieval.topScore,
    retrieval,
  };
}
