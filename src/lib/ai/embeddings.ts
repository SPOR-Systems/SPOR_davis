import { GoogleGenAI } from "@google/genai";
import { callWithFallback, parseChain, type CallMeta } from "@/lib/ai/resilience";
import { countProviderCall } from "@/lib/embed/meter";

/**
 * ============================================================================
 *  EMBEDDINGS
 * ============================================================================
 *  Vectors for knowledge retrieval and for the pre-router.
 *
 *  WHY THIS IS A SEPARATE MODULE FROM gemini.ts
 *  --------------------------------------------
 *  Embeddings are a different quota bucket from generation. That is not a
 *  detail — it is the reason the knowledge path can be fast. Routing a question
 *  by embedding costs ~100ms against a pool the SQL planner is not competing
 *  for, where routing it through the planner costs a call carrying the entire
 *  schema document. A support agent on a call cannot wait for the second one.
 *
 *  Calls still go through resilience.ts, so a quota failure degrades the same
 *  way everything else does rather than throwing into a route handler.
 *
 *  STORAGE
 *  -------
 *  SQLite has no vector type, so a vector is a Float32Array serialised
 *  little-endian into a BLOB and scored by brute force in Node.
 *
 *  The honest ceiling: a full scan of 50k × 768 floats is roughly 100ms, which
 *  is fine. Past that this needs sqlite-vec or Postgres with pgvector. It is
 *  written down here rather than discovered later at 40k documents.
 * ============================================================================
 */

const API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: API_KEY });

/**
 * gemini-embedding-001 first.
 *
 * text-embedding-004 was the head of this chain and 404s on current keys —
 * "not found for API version v1beta, or is not supported for embedContent".
 * The fallback works, so nothing broke, but every process paid a failed call
 * and a disqualification before its first real embedding. A dead model at the
 * head of a chain is a tax on every cold start, and it is invisible unless
 * someone reads the log.
 */
export const EMBEDDING_CHAIN = parseChain(process.env.DAVIS_EMBEDDING_MODEL_CHAIN, [
  "gemini-embedding-001",
  "text-embedding-004",
]);

export const EMBEDDING_DIMS = 768;

/** Per-request cap. The API rejects oversized batches outright. */
const MAX_BATCH = 96;

/** A single call's ceiling. Embeddings are fast; a slow one is a stuck one. */
const EMBED_TIMEOUT_MS = Number(process.env.DAVIS_EMBED_TIMEOUT_MS || 20000);

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

export function serialiseVector(vector: number[]): Buffer {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function deserialiseVector(buffer: Buffer | Uint8Array | null): Float32Array | null {
  if (!buffer || buffer.byteLength === 0) return null;
  if (buffer.byteLength % 4 !== 0) return null;

  // Buffer.from(...) on a slice can leave a non-zero byteOffset, and
  // Float32Array demands 4-byte alignment. Copying is cheaper than debugging
  // the RangeError this throws once every few thousand rows.
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer instanceof Buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer);
  return new Float32Array(copy.buffer);
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cosine similarity. Gemini returns normalised vectors, but normalising here
 * anyway costs one pass and makes the function correct for any input — which
 * matters the day a vector arrives from somewhere else.
 */
export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[]
): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/* -------------------------------------------------------------------------- */
/* Embedding                                                                  */
/* -------------------------------------------------------------------------- */

export type EmbedTaskType =
  /** Indexing content that will later be searched. */
  | "RETRIEVAL_DOCUMENT"
  /** A question being matched against that content. */
  | "RETRIEVAL_QUERY"
  /** Comparing two pieces of content for overlap — conflict detection. */
  | "SEMANTIC_SIMILARITY";

async function embedBatch(
  texts: string[],
  taskType: EmbedTaskType
): Promise<{ vectors: number[][]; meta: CallMeta }> {
  const { value, meta } = await callWithFallback(
    EMBEDDING_CHAIN,
    async (model, ctx) => {
      const response = await ai.models.embedContent({
        model,
        contents: texts,
        config: {
          taskType,
          outputDimensionality: EMBEDDING_DIMS,
          httpOptions: { timeout: ctx.timeoutMs },
          abortSignal: ctx.signal,
        },
      });

      // Embedding calls cost money too, and a document ingest is many of them.
      // Leaving them off the meter would make ingestion look free.
      countProviderCall({ input: response.metadata?.billableCharacterCount });

      const embeddings = response.embeddings;
      if (!embeddings || embeddings.length !== texts.length) {
        throw new Error(
          `Embedding model returned ${embeddings?.length ?? 0} vectors for ${texts.length} inputs.`
        );
      }

      return embeddings.map((e) => {
        const values = e.values;
        if (!values || values.length === 0) {
          throw new Error("Embedding model returned an empty vector.");
        }
        return values;
      });
    },
    { perCallCapMs: EMBED_TIMEOUT_MS },
    "embed content"
  );

  return { vectors: value, meta };
}

/**
 * Embed many texts, batched.
 *
 * Batching is not an optimisation here, it is the difference between ingesting
 * a 200-page PDF in one request and in four hundred.
 */
export async function embedTexts(
  texts: string[],
  taskType: EmbedTaskType = "RETRIEVAL_DOCUMENT"
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const slice = texts.slice(i, i + MAX_BATCH);
    try {
      const { vectors } = await embedBatch(slice, taskType);
      out.push(...vectors);
    } catch (error: any) {
      throw new EmbeddingUnavailableError(
        `Could not embed content (batch ${Math.floor(i / MAX_BATCH) + 1}): ${
          error?.message || error
        }`
      );
    }
  }
  return out;
}

/** Embed one text. Used on every question by the pre-router, so keep it cheap. */
export async function embedOne(
  text: string,
  taskType: EmbedTaskType = "RETRIEVAL_QUERY"
): Promise<number[]> {
  const [vector] = await embedTexts([text], taskType);
  if (!vector) throw new EmbeddingUnavailableError("No vector returned.");
  return vector;
}

/** Whether embeddings can work at all, so callers can degrade instead of erroring. */
export function embeddingsConfigured(): boolean {
  return Boolean(API_KEY);
}
