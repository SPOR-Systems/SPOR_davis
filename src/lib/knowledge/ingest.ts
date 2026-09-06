import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/knowledge/extract";
import { chunkText } from "@/lib/knowledge/chunk";
import { scanForSensitiveData } from "@/lib/knowledge/pii";
import { embedTexts, serialiseVector } from "@/lib/ai/embeddings";

/**
 * ============================================================================
 *  INGEST — file to searchable chunks
 * ============================================================================
 *  extract -> scan for personal data -> chunk -> embed -> store, with the
 *  status advanced at every step.
 *
 *  WHY THE STATUS IS WRITTEN AT EACH STAGE
 *  ---------------------------------------
 *  Ingest is the slowest thing in this application: a large PDF is tens of
 *  seconds of parsing plus several embedding round-trips. Without per-stage
 *  status the UI shows "PENDING" for a minute and the user cannot tell a slow
 *  ingest from a hung one, so they upload it again. Each stage is therefore
 *  committed before it starts, and a failure records WHICH stage failed.
 *
 *  Embedding is treated as non-fatal on purpose: text that is extracted but
 *  unembedded is still readable, still browsable in the help centre, and can
 *  be embedded later. Losing the document because a quota window closed would
 *  be a worse outcome than a document that is temporarily unsearchable.
 * ============================================================================
 */

export type DocumentStatus =
  | "PENDING"
  | "EXTRACTING"
  | "EMBEDDING"
  | "READY"
  | "FAILED"
  /** Text is stored and readable, but retrieval cannot find it yet. */
  | "TEXT_ONLY";

export interface IngestResult {
  documentId: string;
  status: DocumentStatus;
  chunkCount: number;
  warnings: string[];
  error?: string;
  sensitiveFindings: string[];
}

export function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Ingest one already-created Document row.
 *
 * Runs after the upload response has been sent — the caller does not await it,
 * because a support agent uploading a handbook should not watch a spinner for
 * ninety seconds. The status column is the progress channel.
 */
export async function ingestDocument(args: {
  documentId: string;
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}): Promise<IngestResult> {
  const { documentId, buffer, filename, mimeType } = args;
  const warnings: string[] = [];

  const fail = async (error: string): Promise<IngestResult> => {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", ingestError: error, errorMessage: error },
    });
    return { documentId, status: "FAILED", chunkCount: 0, warnings, error, sensitiveFindings: [] };
  };

  try {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "EXTRACTING", ingestError: null, errorMessage: null },
    });

    /* ---- 1. Extract ---------------------------------------------------- */
    const extracted = await extractText({ buffer, filename, mimeType });
    warnings.push(...extracted.warnings);

    if (extracted.error || !extracted.text) {
      return await fail(extracted.error || "No text could be extracted from this file.");
    }

    /* ---- 2. Personal-data scan ----------------------------------------- */
    // Before chunking, so the flag lands on the document even if embedding
    // later fails and the chunks never exist.
    const sensitive = scanForSensitiveData(extracted.text);

    await prisma.document.update({
      where: { id: documentId },
      data: {
        extractedText: extracted.text,
        pageCount: extracted.pageCount ?? null,
        contentHash: hashContent(buffer),
        containsSensitiveData: sensitive.atRisk,
        sensitiveFindings: sensitive.findings.length
          ? JSON.stringify(sensitive.findings)
          : null,
        status: "EMBEDDING",
      },
    });

    /* ---- 3. Chunk ------------------------------------------------------ */
    const chunks = chunkText(extracted.text);
    if (chunks.length === 0) {
      return await fail("The file produced no indexable content.");
    }

    // A re-ingest must not leave the previous run's chunks behind, or the same
    // passage is retrieved twice with different text.
    await prisma.documentChunk.deleteMany({ where: { documentId } });

    /* ---- 4. Embed ------------------------------------------------------ */
    let vectors: number[][] = [];
    let embedError: string | null = null;
    try {
      vectors = await embedTexts(
        // The heading trail rides along in the embedded text: "Timelines" alone
        // matches almost nothing, "Operations > Refunds > Timelines" matches the
        // question someone actually asks.
        chunks.map((c) => (c.headingPath ? `${c.headingPath}\n\n${c.content}` : c.content)),
        "RETRIEVAL_DOCUMENT"
      );
    } catch (error: any) {
      embedError = error?.message || String(error);
      console.warn(`[davis] embedding failed for document ${documentId}: ${embedError}`);
    }

    /* ---- 5. Store ------------------------------------------------------ */
    await prisma.documentChunk.createMany({
      data: chunks.map((chunk, i) => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.index,
        headingPath: chunk.headingPath || null,
        tokenCount: chunk.tokenCount,
        embedding: vectors[i] ? serialiseVector(vectors[i]) : null,
        metadata: JSON.stringify({ headingPath: chunk.headingPath }),
      })),
    });

    const status: DocumentStatus = embedError ? "TEXT_ONLY" : "READY";
    if (embedError) {
      warnings.push(
        "The text was stored and is readable, but it could not be indexed for search " +
          "right now. Re-index it once the model quota recovers."
      );
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { status, ingestError: embedError },
    });

    return {
      documentId,
      status,
      chunkCount: chunks.length,
      warnings,
      sensitiveFindings: sensitive.findings,
    };
  } catch (error: any) {
    console.error(`[davis] ingest crashed for document ${documentId}:`, error);
    return await fail(error?.message || String(error));
  }
}

/**
 * Embed one article, so it is retrievable as a whole.
 *
 * Articles get a single vector rather than chunks: they are already the unit
 * that gets read, and a procedure split across three vectors can be retrieved
 * by its middle, which is exactly the situation the whole-article rule exists
 * to prevent.
 */
export async function embedArticle(articleId: string): Promise<boolean> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) return false;

  const text = [article.path, article.title, article.body]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20000);

  try {
    const [vector] = await embedTexts([text], "RETRIEVAL_DOCUMENT");
    if (!vector) return false;
    await prisma.article.update({
      where: { id: articleId },
      data: { embedding: serialiseVector(vector) },
    });
    return true;
  } catch (error: any) {
    console.warn(`[davis] could not embed article ${articleId}:`, error?.message || error);
    return false;
  }
}
