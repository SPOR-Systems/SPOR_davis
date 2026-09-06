"use client";

import Link from "next/link";

/**
 * Where a knowledge answer came from.
 *
 * Rendered deliberately differently from a data answer's export bar, because
 * the two make different kinds of claim. A figure was MEASURED from the
 * database a second ago; a procedure was QUOTED from a document someone wrote
 * at some point and may not have revisited since. A reader who cannot tell
 * those apart at a glance will eventually treat one as the other.
 *
 * The version number is the useful part: it answers "is this the same text I
 * was shown last week", which is exactly what someone asks when an answer
 * surprises them.
 */

export interface KnowledgeSource {
  articleId: string | null;
  documentId: string | null;
  path: string;
  title: string;
  kind: string;
  version: number;
  score: number;
  confidence: number | null;
  citation: string;
  headingPath: string | null;
}

const KIND_COPY: Record<string, string> = {
  PROCEDURE: "Procedure",
  POLICY: "Policy",
  REFERENCE: "Reference",
  DEFINITION: "Definition",
};

export default function KnowledgeSources({
  sources,
}: {
  sources: KnowledgeSource[];
}) {
  if (!sources.length) return null;

  return (
    <div className="ks">
      <p className="ks-label">
        {sources.length === 1 ? "Source" : "Sources"} — from your documentation, not the database
      </p>
      <ul className="ks-list">
        {sources.map((source, i) => {
          // An article is located by its path and pinned by its version. An
          // uploaded document has neither — what it has is the heading trail
          // of the passage that matched, so that is what gets shown. Printing
          // "handbook.docx · Reference · v1" under the title "handbook.docx"
          // is the filename twice and a version that means nothing.
          const meta = source.articleId
            ? `${source.path} · ${KIND_COPY[source.kind] || source.kind} · v${source.version}`
            : source.headingPath || "Uploaded document";

          const body = (
            <>
              <span className="ks-title">{source.title}</span>
              <span className="ks-meta">{meta}</span>
              {/* A machine-drafted article that nobody has reviewed says so.
                  Unmarked, it reads with the same authority as one an expert
                  wrote and checked. */}
              {source.confidence !== null && source.confidence < 1 && (
                <span className="ks-unreviewed">Drafted automatically · not yet reviewed</span>
              )}
            </>
          );

          return (
            <li key={`${source.articleId || source.documentId}-${i}`} className="ks-item">
              {source.articleId ? (
                <Link href={`/knowledge/browse?article=${source.articleId}`} className="ks-link">
                  {body}
                </Link>
              ) : (
                <span className="ks-link ks-link-plain">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
