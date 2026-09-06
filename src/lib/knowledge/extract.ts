/**
 * ============================================================================
 *  EXTRACTION — file bytes to plain text
 * ============================================================================
 *  One rule runs through this file: a file that yielded nothing usable must
 *  FAIL LOUDLY. The failure mode that matters is not a crash — it is a scanned
 *  PDF that extracts to an empty string, ingests "successfully", and sits in
 *  the knowledge base as an article nobody can find and nothing can answer
 *  from. Every extractor below returns an explicit reason when it comes up
 *  empty, and the caller records it on the document.
 * ============================================================================
 */

export type ExtractKind = "pdf" | "docx" | "markdown" | "text" | "tabular";

export interface ExtractResult {
  text: string;
  pageCount?: number;
  kind: ExtractKind;
  /** Set when nothing usable came out; the document is marked FAILED with this. */
  error?: string;
  /** Non-fatal things the user should know about the ingest. */
  warnings: string[];
}

/** Anything shorter than this from a document with real bytes is suspicious. */
const MIN_USEFUL_CHARS = 40;

export function detectKind(filename: string, mimeType?: string): ExtractKind | null {
  const ext = filename.toLowerCase().split(".").pop() || "";
  const mime = (mimeType || "").toLowerCase();

  if (ext === "pdf" || mime.includes("pdf")) return "pdf";
  if (ext === "docx" || mime.includes("wordprocessingml")) return "docx";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt" || mime.startsWith("text/plain")) return "text";
  if (ext === "csv" || ext === "tsv" || ext === "xlsx" || ext === "xls") return "tabular";
  return null;
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * PDF text extraction.
 *
 * unpdf rather than pdf-parse. pdf-parse bundles an old pdf.js that rejects
 * perfectly valid files with "bad XRef entry" — it failed on output from both
 * reportlab and pypdf while accepting LibreOffice's, which is exactly the kind
 * of producer-dependent breakage that would show up as "some of our PDFs just
 * do not work" months from now with no pattern to it. unpdf wraps a current
 * pdf.js build, has no native dependencies, and is built for serverless
 * runtimes, which is what this route is.
 */
async function extractPdf(buffer: Buffer): Promise<ExtractResult> {
  const warnings: string[] = [];
  try {
    const { extractText: unpdfExtract, getDocumentProxy } = await import("unpdf");

    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text: raw } = await unpdfExtract(doc, { mergePages: true });
    const text = String(raw || "").trim();

    if (text.length < MIN_USEFUL_CHARS) {
      return {
        text: "",
        kind: "pdf",
        pageCount: totalPages,
        warnings,
        error:
          `This PDF has ${totalPages || "an unknown number of"} page(s) but almost no ` +
          `extractable text, which usually means it is a scan or an image export. ` +
          `DAVIS cannot read it without OCR. Re-export it with a text layer, or paste ` +
          `the content in as an article.`,
      };
    }

    return { text, kind: "pdf", pageCount: totalPages, warnings };
  } catch (error: any) {
    return {
      text: "",
      kind: "pdf",
      warnings,
      error: `The PDF could not be read: ${error?.message || error}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* DOCX                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The subset of HTML mammoth emits, turned into markdown.
 *
 * mammoth.extractRawText would be one line, but it throws away the heading
 * structure — and the heading trail is what lets a citation say
 * "Operations > Refunds > Timelines" instead of "page 4", and what makes a chunk
 * findable by the words someone actually searches for. mammoth has no typed
 * markdown converter, and pulling in turndown to convert eight tags would be a
 * dependency for nothing, so this handles those eight tags.
 */
function htmlToMarkdown(html: string): string {
  return html
    // Headings first: everything downstream depends on these surviving.
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) =>
      `\n\n${"#".repeat(Number(level))} ${stripTags(inner)}\n\n`
    )
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<\/(?:ul|ol)>/gi, "\n\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => `\n\n${stripTags(inner)}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function extractDocx(buffer: Buffer): Promise<ExtractResult> {
  const warnings: string[] = [];
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ buffer });
    const text = htmlToMarkdown(result.value || "").trim();

    for (const message of result.messages || []) {
      if (message.type === "warning") warnings.push(message.message);
    }

    if (text.length < MIN_USEFUL_CHARS) {
      return {
        text: "",
        kind: "docx",
        warnings,
        error:
          "This document converted to almost no text. If its content is inside images " +
          "or text boxes, DAVIS cannot read it.",
      };
    }

    return { text, kind: "docx", warnings };
  } catch (error: any) {
    return {
      text: "",
      kind: "docx",
      warnings,
      error: `The Word document could not be read: ${error?.message || error}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Tabular                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Header plus a sample of rows, and nothing more.
 *
 * A spreadsheet in the knowledge base is DOCUMENTATION OF A FILE'S SHAPE, never
 * queryable data. Ingesting all forty thousand rows would put figures into the
 * retrieval path, where the governing rule says figures must never come from —
 * they would be embedded, retrieved months later, and quoted as current. What
 * is useful here is "this file exists and these are its columns".
 */
const TABULAR_SAMPLE_ROWS = 15;

function extractTabular(buffer: Buffer, filename: string): ExtractResult {
  const warnings: string[] = [];
  try {
    const raw = buffer.toString("utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      return { text: "", kind: "tabular", warnings, error: "The file is empty." };
    }

    const sampled = lines.slice(0, TABULAR_SAMPLE_ROWS + 1);
    const omitted = Math.max(0, lines.length - sampled.length);

    const text = [
      `# ${filename}`,
      "",
      `Tabular file with ${lines.length - 1} data row(s). ` +
        `This is a description of the file's structure, not its data — DAVIS answers ` +
        `questions about figures from the connected database, never from this sample.`,
      "",
      "## Columns and sample rows",
      "",
      "```",
      ...sampled,
      omitted > 0 ? `... ${omitted} further row(s) not included` : "",
      "```",
    ]
      .filter(Boolean)
      .join("\n");

    if (omitted > 0) {
      warnings.push(
        `Only the header and first ${TABULAR_SAMPLE_ROWS} rows were ingested. ` +
          `Spreadsheets are indexed for their structure, not their contents.`
      );
    }

    return { text, kind: "tabular", warnings };
  } catch (error: any) {
    return {
      text: "",
      kind: "tabular",
      warnings,
      error: `The file could not be read as text: ${error?.message || error}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Plain text and markdown                                                    */
/* -------------------------------------------------------------------------- */

function extractPlain(buffer: Buffer, kind: ExtractKind): ExtractResult {
  const text = buffer.toString("utf8").trim();
  if (text.length < MIN_USEFUL_CHARS) {
    return { text: "", kind, warnings: [], error: "The file has no readable content." };
  }
  return { text, kind, warnings: [] };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function extractText(args: {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}): Promise<ExtractResult> {
  const kind = detectKind(args.filename, args.mimeType);

  if (!kind) {
    return {
      text: "",
      kind: "text",
      warnings: [],
      error:
        `DAVIS does not know how to read "${args.filename}". Supported: PDF, Word (.docx), ` +
        `Markdown, plain text, CSV and Excel.`,
    };
  }

  switch (kind) {
    case "pdf":
      return extractPdf(args.buffer);
    case "docx":
      return extractDocx(args.buffer);
    case "tabular":
      return extractTabular(args.buffer, args.filename);
    default:
      return extractPlain(args.buffer, kind);
  }
}
