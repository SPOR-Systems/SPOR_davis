/**
 * ============================================================================
 *  CHUNKING
 * ============================================================================
 *  Chunks are an INDEX, not the reading material. Retrieval scores against
 *  them and then loads the whole parent article, so a chunk does not have to
 *  be self-contained or readable on its own — it only has to be findable.
 *
 *  That changes what good chunking is. The usual worry, "did I cut a sentence
 *  in half and ruin the answer", does not apply: the model never sees the cut.
 *  What matters is that every part of the document is reachable by some query,
 *  and that each chunk knows where it came from so a citation can say
 *  "Operations > Refunds > Timelines" rather than "chunk 47".
 * ============================================================================
 */

export interface Chunk {
  content: string;
  index: number;
  /** "Operations > Refunds > Timelines" — the heading trail above this text. */
  headingPath: string;
  /** Rough, deliberately: see estimateTokens. */
  tokenCount: number;
}

/** Target size in characters. ~250 tokens: big enough to carry a topic. */
const TARGET_CHARS = 1000;
/** Hard ceiling before a paragraph is split mid-way. */
const MAX_CHARS = 1600;
/**
 * Trailing text carried into the next chunk. Cheap insurance for a fact that
 * straddles a boundary — with whole-article reading the cost of a little
 * duplication in the index is close to zero.
 */
const OVERLAP_CHARS = 150;

/**
 * Characters per token, averaged over English prose.
 *
 * Deliberately a heuristic and not tiktoken: this number decides how big a
 * chunk is, and a chunk that is 15% off target costs nothing. A wasm tokeniser
 * dependency to get it exactly right would buy nothing at all.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/** Track the heading trail so each chunk knows where in the document it sits. */
function headingTrail(stack: string[]): string {
  return stack.filter(Boolean).join(" > ");
}

export function chunkText(text: string): Chunk[] {
  const lines = (text || "").split(/\r?\n/);

  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferHeading = "";

  const flush = () => {
    const content = buffer.join("\n").trim();
    buffer = [];
    bufferChars = 0;
    if (!content) return;

    chunks.push({
      content,
      index: chunks.length,
      headingPath: bufferHeading,
      tokenCount: estimateTokens(content),
    });
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);

    if (heading) {
      // A heading is a natural boundary; do not carry the previous section's
      // text across it.
      flush();

      const level = heading[1].length;
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = heading[2].trim();
      bufferHeading = headingTrail(stack);

      // The heading itself leads its own chunk, so a query matching the
      // heading text finds the section under it.
      buffer.push(line);
      bufferChars += line.length + 1;
      continue;
    }

    if (!bufferHeading) bufferHeading = headingTrail(stack);

    // A single paragraph longer than the ceiling gets split on its own.
    if (line.length > MAX_CHARS) {
      flush();
      for (let i = 0; i < line.length; i += MAX_CHARS) {
        chunks.push({
          content: line.slice(i, i + MAX_CHARS),
          index: chunks.length,
          headingPath: bufferHeading,
          tokenCount: estimateTokens(line.slice(i, i + MAX_CHARS)),
        });
      }
      continue;
    }

    if (bufferChars + line.length > TARGET_CHARS && bufferChars > 0) {
      const carried = buffer.join("\n").slice(-OVERLAP_CHARS);
      flush();
      if (carried.trim()) {
        buffer.push(carried.trim());
        bufferChars = carried.length;
      }
    }

    buffer.push(line);
    bufferChars += line.length + 1;
  }

  flush();

  // Re-index: the split path above pushes directly and can leave gaps if a
  // flush produced nothing.
  return chunks.map((c, i) => ({ ...c, index: i }));
}
