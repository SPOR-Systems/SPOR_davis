"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * ============================================================================
 *  HELP CENTRE
 * ============================================================================
 *  Everything DAVIS can answer from, readable directly, without asking it a
 *  question first.
 *
 *  It exists because a question is not always the fastest route. Someone who
 *  knows roughly where a thing lives finds it faster by navigating than by
 *  phrasing a query, and a procedure is easier to follow on a page than in a
 *  chat bubble you have to scroll back through mid-call. It is also where a
 *  Tier 2 answer becomes a link instead of a retyped explanation.
 *
 *  TWO KINDS OF THING LIVE HERE, AND THE DIFFERENCE IS THE POINT
 *  -------------------------------------------------------------
 *  ARTICLES are curated: a path in the tree, a version, and — for procedures —
 *  ordered steps that DAVIS renders whole. They are what a citation can point
 *  at meaningfully.
 *
 *  DOCUMENTS are the raw uploads. Searchable and readable, but unstructured:
 *  no version, no ordered steps, and a citation can only name the file and the
 *  heading it matched under.
 *
 *  The first version of this page showed only articles, which made it empty and
 *  inert for anyone who had uploaded documents and not yet written any up —
 *  which is everyone, at the start. Both are now first-class, and the gap
 *  between them is stated rather than hidden, because closing it is the whole
 *  job of the Atlas.
 * ============================================================================
 */

interface ArticleRow {
  id: string;
  path: string;
  title: string;
  kind: string;
  version: number;
  status: string;
}

interface DocumentRow {
  id: string;
  name: string;
  status: string;
  pageCount: number | null;
  chunkCount: number;
  containsSensitiveData: boolean;
}

type Reading =
  | {
      kind: "article";
      id: string;
      path: string;
      title: string;
      articleKind: string;
      version: number;
      body: string;
      steps: string[] | null;
      updatedAt: string;
    }
  | {
      kind: "document";
      id: string;
      name: string;
      text: string;
      pageCount: number | null;
      containsSensitiveData: boolean;
      sensitiveFindings: string[];
    };

interface SearchHit {
  articleId: string | null;
  documentId: string | null;
  path: string;
  title: string;
  kind: string;
  version: number;
  score: number;
  excerpt: string;
}

const KIND_COPY: Record<string, string> = {
  PROCEDURE: "Procedure",
  POLICY: "Policy",
  REFERENCE: "Reference",
  DEFINITION: "Definition",
};

/** Rendering a 200-page handbook as markdown locks the tab. */
const MAX_RENDER_CHARS = 120_000;

function groupByFolder(articles: ArticleRow[]): Map<string, ArticleRow[]> {
  const groups = new Map<string, ArticleRow[]>();
  for (const article of articles) {
    const folder = article.path || "Uncategorised";
    const list = groups.get(folder) || [];
    list.push(article);
    groups.set(folder, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export default function HelpCentrePage() {
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetch("/api/knowledge/articles?status=PUBLISHED")
      .then((r) => r.json())
      .then((d) => setArticles(d.articles || []))
      .catch(() => setArticles([]));

    fetch("/api/knowledge/documents")
      .then((r) => r.json())
      .then((d) =>
        // Only what is actually readable. A failed ingest has no text behind
        // it, so listing it here would be an invitation to click nothing.
        setDocuments(
          (d.documents || []).filter((doc: DocumentRow) => doc.status !== "FAILED")
        )
      )
      .catch(() => setDocuments([]));
  }, []);

  const openArticle = useCallback(async (id: string) => {
    const res = await fetch(`/api/knowledge/articles/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    const a = data.article;
    setReading({
      kind: "article",
      id: a.id,
      path: a.path,
      title: a.title,
      articleKind: a.kind,
      version: a.version,
      body: a.body,
      steps: a.steps,
      updatedAt: a.updatedAt,
    });
  }, []);

  const openDocument = useCallback(async (id: string) => {
    const res = await fetch(`/api/knowledge/documents/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    const d = data.document;
    setReading({
      kind: "document",
      id: d.id,
      name: d.name,
      text: d.extractedText || "",
      pageCount: d.pageCount,
      containsSensitiveData: Boolean(d.containsSensitiveData),
      sensitiveFindings: d.sensitiveFindings || [],
    });
  }, []);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      setHits(data.results || []);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const folders = useMemo(() => groupByFolder(articles), [articles]);

  return (
    <div className="hc-page">
      <header className="hc-header">
        <div>
          <h1 className="text-2xl font-bold">Help Centre</h1>
          <p className="text-sm text-text-secondary">
            Everything DAVIS can answer from, readable directly.
          </p>
        </div>
        <Link href="/knowledge" className="kb-browse-link">
          Manage knowledge base
        </Link>
      </header>

      <form
        className="hc-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          className="kb-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search procedures, policies and reference material"
        />
        <button className="kb-primary" type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
        {hits !== null && (
          <button
            type="button"
            className="kb-secondary"
            onClick={() => {
              setHits(null);
              setQuery("");
            }}
          >
            Clear
          </button>
        )}
      </form>

      <div className="hc-body">
        <nav className="hc-nav">
          {hits !== null ? (
            hits.length === 0 ? (
              <p className="kb-empty">
                Nothing matched. If this is something people ask about, it is worth writing
                down.
              </p>
            ) : (
              <ul className="hc-hits">
                {hits.map((hit, i) => (
                  <li key={`${hit.articleId || hit.documentId}-${i}`}>
                    <button
                      className="hc-hit"
                      onClick={() =>
                        hit.articleId
                          ? void openArticle(hit.articleId)
                          : hit.documentId
                          ? void openDocument(hit.documentId)
                          : undefined
                      }
                    >
                      <span className="hc-hit-title">{hit.title}</span>
                      <span className="hc-hit-path">
                        {hit.articleId
                          ? `${hit.path} · v${hit.version}`
                          : hit.path !== hit.title
                          ? hit.path
                          : "Uploaded document"}
                      </span>
                      <span className="hc-hit-excerpt">{hit.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              {articles.length > 0 &&
                [...folders.entries()].map(([folder, items]) => (
                  <section key={folder} className="hc-folder">
                    <h2 className="hc-folder-title">{folder}</h2>
                    <ul>
                      {items.map((article) => (
                        <li key={article.id}>
                          <button
                            className={
                              reading?.kind === "article" && reading.id === article.id
                                ? "hc-item is-active"
                                : "hc-item"
                            }
                            onClick={() => void openArticle(article.id)}
                          >
                            {article.title}
                            <span className="hc-item-kind">
                              {KIND_COPY[article.kind] || article.kind}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

              {documents.length > 0 && (
                <section className="hc-folder">
                  <h2 className="hc-folder-title">
                    Uploaded documents ({documents.length})
                  </h2>
                  <ul>
                    {documents.map((doc) => (
                      <li key={doc.id}>
                        <button
                          className={
                            reading?.kind === "document" && reading.id === doc.id
                              ? "hc-item is-active"
                              : "hc-item"
                          }
                          onClick={() => void openDocument(doc.id)}
                        >
                          {doc.name}
                          <span className="hc-item-kind">
                            {doc.pageCount ? `${doc.pageCount} pages` : "Document"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {articles.length === 0 && documents.length === 0 && (
                <p className="kb-empty">Nothing here yet.</p>
              )}
            </>
          )}
        </nav>

        <article className="hc-article">
          {!reading ? (
            <EmptyReadingPane
              articleCount={articles.length}
              documentCount={documents.length}
            />
          ) : reading.kind === "article" ? (
            <>
              <p className="hc-article-path">{reading.path}</p>
              <h2 className="hc-article-title">{reading.title}</h2>
              <p className="hc-article-meta">
                {KIND_COPY[reading.articleKind] || reading.articleKind} · v{reading.version} ·
                updated {new Date(reading.updatedAt).toLocaleDateString()}
              </p>

              <div className="markdown-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reading.body}</ReactMarkdown>
              </div>

              {/* Steps render from the stored array, not from prose, so the page
                  and the chat answer are the same procedure in the same order. */}
              {reading.steps && reading.steps.length > 0 && (
                <ol className="hc-steps">
                  {reading.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <>
              <p className="hc-article-path">Uploaded document</p>
              <h2 className="hc-article-title">{reading.name}</h2>
              <p className="hc-article-meta">
                {reading.pageCount ? `${reading.pageCount} pages · ` : ""}
                extracted text, as DAVIS reads it
              </p>

              {reading.containsSensitiveData && (
                <div className="kb-notice kb-notice-warn" style={{ marginBottom: "1rem" }}>
                  Flagged for possible personal data: {reading.sensitiveFindings.join(", ")}.
                </div>
              )}

              {/* A raw upload is not a curated article, and saying so is the
                  point rather than a caveat: it has no version to cite, no
                  ordered steps for DAVIS to deliver whole, and a citation can
                  only name the file. Writing it up is what fixes all three. */}
              <div className="hc-raw-note">
                <p>
                  This is a raw upload. DAVIS can answer from it and quote it, but it has no
                  version to cite and no ordered steps — so a procedure inside it cannot be
                  guaranteed to arrive complete.
                </p>
                <Link href={`/knowledge?fromDocument=${reading.id}`} className="kb-primary">
                  Write this up as an article
                </Link>
              </div>

              <div className="hc-raw-text">
                {reading.text.slice(0, MAX_RENDER_CHARS) || "(no text was extracted)"}
                {reading.text.length > MAX_RENDER_CHARS && (
                  <p className="hc-truncated">
                    … showing the first {MAX_RENDER_CHARS.toLocaleString()} characters of{" "}
                    {reading.text.length.toLocaleString()}. Search still covers all of it.
                  </p>
                )}
              </div>
            </>
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * The empty pane earns its space by explaining the one thing about this page
 * that is not obvious: why documents and articles are different, and why you
 * would bother writing one up when search already finds the document.
 */
function EmptyReadingPane({
  articleCount,
  documentCount,
}: {
  articleCount: number;
  documentCount: number;
}) {
  if (articleCount === 0 && documentCount === 0) {
    return (
      <p className="kb-empty">
        Nothing uploaded yet. Add documents in the knowledge base and they become searchable
        here.
      </p>
    );
  }

  return (
    <div className="hc-intro">
      <p className="hc-intro-lead">Choose something on the left, or search above.</p>

      {articleCount === 0 && documentCount > 0 && (
        <>
          <p>
            You have {documentCount} document{documentCount === 1 ? "" : "s"} and no articles
            yet. DAVIS can already answer from the documents — but there is a real difference
            between the two:
          </p>
          <ul className="hc-intro-list">
            <li>
              <strong>A document</strong> is the file as uploaded. It is searchable and
              quotable, and a citation can name the file and the heading it matched under.
            </li>
            <li>
              <strong>An article</strong> is written up: it has a place in the tree, a version
              number, and — if it is a procedure — steps stored in order, which DAVIS delivers
              complete or not at all.
            </li>
          </ul>
          <p>
            That last part is why it matters. A procedure buried in a PDF can come back
            summarised; a procedure stored as ordered steps cannot.
          </p>
        </>
      )}
    </div>
  );
}
