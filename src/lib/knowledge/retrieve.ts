import { prisma } from "@/lib/prisma";
import {
  cosineSimilarity,
  deserialiseVector,
  embedOne,
  embeddingsConfigured,
} from "@/lib/ai/embeddings";

/**
 * ============================================================================
 *  RETRIEVAL — two stages, and the second one is the point
 * ============================================================================
 *  STAGE 1 finds candidates by scoring CHUNKS. Cheap, good recall.
 *  STAGE 2 loads the WHOLE parent article and hands that to the model.
 *
 *  The model never sees a chunk. That is not a stylistic preference:
 *
 *  1. A citation has to point at something a person can open. "Chunk 47 of
 *     handbook.pdf" is not checkable; "Operations / Refunds, v3" is.
 *  2. A procedure cannot be delivered whole from a fragment of itself. If the
 *     model is handed chunk 3 of 5 of a procedure, the best it can produce is a
 *     confident, incomplete instruction — which is the specific failure this
 *     system is built to avoid.
 *
 *  Chunks are an index. Articles are the reading material.
 * ============================================================================
 */

/** Below this, a match is noise. Governs abstention: nothing above it means "not documented". */
export const MIN_RELEVANCE = 0.55;
/** Comfortably above the floor — used by the pre-router to skip planning. */
export const STRONG_RELEVANCE = 0.72;

const CANDIDATE_CHUNKS = 8;
const MAX_ARTICLES_READ = 3;

export interface RetrievedSource {
  articleId: string | null;
  documentId: string | null;
  path: string;
  title: string;
  kind: string;
  version: number;
  /** The COMPLETE text the model reads. Never a fragment. */
  body: string;
  /** Ordered steps, when this is a procedure. */
  steps: string[] | null;
  score: number;
  headingPath?: string | null;
  confidence?: number | null;
  /**
   * The exact citation line to print, computed here rather than left to the
   * model.
   *
   * An article and an uploaded document are cited differently and the
   * difference matters. An article has a path in the tree and a version, so
   * "Operations / Refunds, v3" tells a reader where to look and whether the
   * text has changed since they last read it. A raw document has neither —
   * formatting one with the article template produces
   * "handbook.docx (handbook.docx, v1)", which repeats the filename and
   * asserts a version that does not exist. What a document DOES have is the
   * heading trail of the passage that matched, which is the useful part.
   */
  citation: string;
}

function articleCitation(title: string, path: string, version: number): string {
  return `${title} (${path}, v${version})`;
}

function documentCitation(name: string, headingPath?: string | null): string {
  return headingPath ? `${name} — ${headingPath}` : name;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  topScore: number;
  /** True when nothing cleared MIN_RELEVANCE — the abstention signal. */
  empty: boolean;
  /** Set when retrieval could not run at all, as opposed to finding nothing. */
  unavailable?: string;
}

function parseSteps(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((s) => String(s)).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Score every stored vector in the knowledge base against the question.
 *
 * A full scan, deliberately. At the documented ceiling (§ embeddings.ts) this
 * is ~100ms, and an exact scan has no index to go stale, no tuning, and no
 * recall cliff. The moment it stops being fast enough the fix is sqlite-vec,
 * not a hand-rolled approximation.
 */
export async function retrieve(args: {
  question: string;
  knowledgeBaseId: string;
  limit?: number;
}): Promise<RetrievalResult> {
  const { question, knowledgeBaseId } = args;

  if (!embeddingsConfigured()) {
    return {
      sources: [],
      topScore: 0,
      empty: true,
      unavailable: "No embedding model is configured, so the knowledge base cannot be searched.",
    };
  }

  let queryVector: number[];
  try {
    queryVector = await embedOne(question, "RETRIEVAL_QUERY");
  } catch (error: any) {
    return {
      sources: [],
      topScore: 0,
      empty: true,
      unavailable: `The knowledge base could not be searched: ${error?.message || error}`,
    };
  }

  const query = new Float32Array(queryVector);

  /* ---- Stage 1: score chunks and article vectors ----------------------- */

  const [chunks, articles] = await Promise.all([
    prisma.documentChunk.findMany({
      where: { document: { knowledgeBaseId } },
      select: {
        id: true,
        documentId: true,
        embedding: true,
        headingPath: true,
      },
    }),
    prisma.article.findMany({
      where: { knowledgeBaseId, status: "PUBLISHED" },
      select: {
        id: true,
        path: true,
        title: true,
        kind: true,
        body: true,
        steps: true,
        version: true,
        confidence: true,
        embedding: true,
        sourceDocumentId: true,
      },
    }),
  ]);

  type Scored = { score: number; articleId?: string; documentId?: string; headingPath?: string | null };
  const scored: Scored[] = [];

  for (const chunk of chunks) {
    const vector = deserialiseVector(chunk.embedding as Buffer | null);
    if (!vector) continue;
    scored.push({
      score: cosineSimilarity(query, vector),
      documentId: chunk.documentId,
      headingPath: chunk.headingPath,
    });
  }

  for (const article of articles) {
    const vector = deserialiseVector(article.embedding as Buffer | null);
    if (!vector) continue;
    scored.push({ score: cosineSimilarity(query, vector), articleId: article.id });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, CANDIDATE_CHUNKS);
  const topScore = candidates[0]?.score ?? 0;

  if (topScore < MIN_RELEVANCE) {
    // Nothing is close enough. This is the abstention signal, and it must stay
    // a real outcome: assembling an answer from the best of a bad set is how a
    // plausible, wrong procedure gets delivered.
    return { sources: [], topScore, empty: true };
  }

  /* ---- Stage 2: resolve to whole articles ------------------------------ */

  const byArticle = new Map<string, number>();
  const byDocument = new Map<string, { score: number; headingPath?: string | null }>();

  for (const c of candidates) {
    if (c.score < MIN_RELEVANCE) continue;
    if (c.articleId) {
      byArticle.set(c.articleId, Math.max(byArticle.get(c.articleId) ?? 0, c.score));
    } else if (c.documentId) {
      const existing = byDocument.get(c.documentId);
      if (!existing || c.score > existing.score) {
        byDocument.set(c.documentId, { score: c.score, headingPath: c.headingPath });
      }
    }
  }

  // A document that has an article derived from it is represented by that
  // article — the structured version is the citable one.
  for (const article of articles) {
    if (article.sourceDocumentId && byDocument.has(article.sourceDocumentId)) {
      const doc = byDocument.get(article.sourceDocumentId)!;
      byArticle.set(article.id, Math.max(byArticle.get(article.id) ?? 0, doc.score));
      byDocument.delete(article.sourceDocumentId);
    }
  }

  const sources: RetrievedSource[] = [];

  for (const [articleId, score] of byArticle) {
    const article = articles.find(
      (a: (typeof articles)[number]) => a.id === articleId
    );
    if (!article) continue;
    sources.push({
      articleId: article.id,
      documentId: article.sourceDocumentId,
      path: article.path,
      title: article.title,
      kind: article.kind,
      version: article.version,
      body: article.body,
      steps: parseSteps(article.steps),
      score,
      confidence: article.confidence,
      citation: articleCitation(article.title, article.path, article.version),
    });
  }

  if (byDocument.size > 0) {
    const docs = await prisma.document.findMany({
      where: { id: { in: [...byDocument.keys()] } },
      select: { id: true, name: true, extractedText: true },
    });
    for (const doc of docs) {
      const hit = byDocument.get(doc.id)!;
      sources.push({
        articleId: null,
        documentId: doc.id,
        // The heading trail of the passage that matched, not the filename
        // again. "Operations > Refunds > Timelines" is a location; repeating
        // the filename is not.
        path: hit.headingPath || doc.name,
        title: doc.name,
        kind: "REFERENCE",
        version: 1,
        // The whole document, capped. A source the model reads in full is the
        // point; the cap only exists so a 300-page handbook cannot blow the
        // context window.
        body: (doc.extractedText || "").slice(0, 24000),
        steps: null,
        score: hit.score,
        headingPath: hit.headingPath,
        citation: documentCitation(doc.name, hit.headingPath),
      });
    }
  }

  sources.sort((a, b) => b.score - a.score);

  return {
    sources: sources.slice(0, args.limit ?? MAX_ARTICLES_READ),
    topScore,
    empty: sources.length === 0,
  };
}

/** The single knowledge base for an organisation, created on first use. */
export async function getOrCreateKnowledgeBase(organizationId: string) {
  const existing = await prisma.knowledgeBase.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  return prisma.knowledgeBase.create({
    data: {
      name: "Knowledge Base",
      description: "Procedures, policies and reference material DAVIS answers from.",
      organizationId,
    },
  });
}
