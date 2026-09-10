"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cachedJson,
  invalidatePrefix,
  prefetchJson,
  remembered,
} from "@/lib/clientCache";
import Link from "next/link";

/**
 * Knowledge base management.
 *
 * Two things live here that the help centre does not show: the ingest state of
 * every uploaded file, and the article editor. The first exists because ingest
 * fails quietly in ways nobody would otherwise discover — a scanned PDF that
 * extracted nothing looks exactly like a document nobody has asked about yet.
 */

interface DocumentRow {
  id: string;
  name: string;
  type: string;
  size: number;
  status: string;
  pageCount: number | null;
  ingestError: string | null;
  containsSensitiveData: boolean;
  sensitiveFindings: string[];
  chunkCount: number;
  createdAt: string;
}

interface ArticleRow {
  id: string;
  path: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  confidence: number | null;
  sourceKind: string;
  updatedAt: string;
}

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "Queued", tone: "kb-tone-muted" },
  EXTRACTING: { label: "Reading", tone: "kb-tone-busy" },
  EMBEDDING: { label: "Indexing", tone: "kb-tone-busy" },
  READY: { label: "Searchable", tone: "kb-tone-ok" },
  TEXT_ONLY: { label: "Readable, not indexed", tone: "kb-tone-warn" },
  FAILED: { label: "Failed", tone: "kb-tone-bad" },
};

const KIND_COPY: Record<string, string> = {
  PROCEDURE: "Procedure",
  POLICY: "Policy",
  REFERENCE: "Reference",
  DEFINITION: "Definition",
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Delete, with the confirmation inline rather than in a dialog.
 *
 * Two clicks, and the second one says what it will do. A browser confirm()
 * blocks the whole tab and is trivially click-through; a modal for a one-line
 * action is heavier than the action. This keeps the warning attached to the row
 * being deleted, which is the thing the user actually needs to be sure about.
 */
function DeleteControl({
  label,
  onDelete,
  busy,
}: {
  /** What the second click will remove, in plain words. */
  label: string;
  onDelete: () => Promise<void>;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    // Disarm on its own, so a half-pressed delete never sits waiting for a
    // stray click later.
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        className="kb-delete"
        onClick={() => setArmed(true)}
        disabled={busy}
        aria-label={`Delete ${label}`}
      >
        Delete
      </button>
    );
  }

  return (
    <span className="kb-confirm">
      <span className="kb-confirm-text">{label}?</span>
      <button
        type="button"
        className="kb-delete kb-delete-armed"
        onClick={() => void onDelete()}
        disabled={busy}
      >
        {busy ? "Deleting…" : "Yes, delete"}
      </button>
      <button type="button" className="kb-secondary" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

export default function KnowledgePage() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [tab, setTab] = useState<"documents" | "articles">("documents");
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  /** Seed for the editor when arriving from "write this up" in the help centre. */
  const [seed, setSeed] = useState<{ title: string; body: string } | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const apply = useCallback((kb: any, docs: any, arts: any) => {
    if (kb?.counts) setCounts(kb.counts);
    if (kb?.isAdmin !== undefined) setIsAdmin(Boolean(kb.isAdmin));
    if (docs?.documents) setDocuments(docs.documents);
    if (arts?.articles) setArticles(arts.articles);
  }, []);

  /**
   * Show whatever the dashboard already prefetched, immediately, then check.
   *
   * These three requests used to run on every visit while the page sat empty.
   * They are the same three every time, and the answer rarely changes between
   * one visit and the next — so the wait was almost always for news that there
   * was no news.
   *
   * `fresh` forces a round trip, for after an upload or a delete, where the
   * whole point is that something DID change.
   */
  const load = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      const urls = [
        "/api/knowledge",
        "/api/knowledge/documents",
        "/api/knowledge/articles",
      ] as const;

      if (opts.fresh) invalidatePrefix("/api/knowledge");

      if (!opts.fresh) {
        const ready = urls.map((u) => cachedJson<any>(u));
        if (ready.every(Boolean)) {
          const [kb, docs, arts] = await Promise.all(ready as Promise<any>[]);
          apply(kb, docs, arts);
          // Painted from cache; now confirm it is still true, quietly.
          invalidatePrefix("/api/knowledge");
        } else {
          // Nothing in memory — a refresh. Paint from the copy kept in
          // sessionStorage so the page is filled in before the network answers,
          // rather than sitting empty for the length of a round trip.
          const saved = urls.map((u) => remembered<any>(u));
          if (saved.every(Boolean)) apply(saved[0], saved[1], saved[2]);
        }
      }

      const [kb, docs, arts] = await Promise.all(
        urls.map((u) => prefetchJson<any>(u).catch(() => null))
      );
      apply(kb, docs, arts);
    },
    [apply]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Arriving from "Write this up as an article" in the help centre.
   *
   * Read from window.location rather than useSearchParams: this page is
   * statically rendered, and useSearchParams would force it dynamic or demand a
   * Suspense boundary for a one-off query string.
   */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("fromDocument");
    if (!id) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/knowledge/documents/${id}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const doc = data.document;
        setSeed({
          // The extracted text is the starting point, not the article. The
          // author trims it down — which is exactly the work that turns a file
          // into something citable.
          title: String(doc.name || "").replace(/\.[^.]+$/, ""),
          body: String(doc.extractedText || "").slice(0, 40000),
        });
        setTab("articles");
        setEditorOpen(true);
      } catch {
        /* nothing to seed with; the editor still opens empty */
      }
    })();

    // Clear the parameter so a refresh does not reopen the editor.
    window.history.replaceState({}, "", "/knowledge");
    return () => {
      cancelled = true;
    };
  }, []);

  // Ingest runs after the upload response returns, so poll while anything is
  // still working. Without this the user sees "Queued" indefinitely and cannot
  // tell a slow parse from a stuck one — so they upload it again.
  useEffect(() => {
    const working = documents.some((d) =>
      ["PENDING", "EXTRACTING", "EMBEDDING"].includes(d.status)
    );
    if (!working) return;
    const id = setInterval(() => void load({ fresh: true }), 2500);
    return () => clearInterval(id);
  }, [documents, load]);

  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = async (kind: "documents" | "articles", id: string, name: string) => {
    setDeleting(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/knowledge/${kind}/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setNotice({ kind: "error", text: body?.error || `${name} could not be deleted.` });
        return;
      }
      await load({ fresh: true });
    } catch {
      setNotice({ kind: "error", text: `${name} could not be deleted.` });
    } finally {
      setDeleting(null);
    }
  };

  const [rescanning, setRescanning] = useState(false);

  /**
   * Re-check every stored document against the current scanner rules.
   *
   * Uses the text already on each document, so this costs no upload, no
   * re-parse and no model call. It exists because a scan result is only ever a
   * snapshot of the rules on the day of upload — and those rules keep changing.
   */
  const rescan = async () => {
    setRescanning(true);
    setNotice(null);
    try {
      const res = await fetch("/api/knowledge/rescan", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "The re-scan could not run." });
        return;
      }
      const parts = [`Re-checked ${data.scanned} document${data.scanned === 1 ? "" : "s"}.`];
      if (data.changed === 0) {
        parts.push("Nothing changed.");
      } else {
        if (data.newlyFlagged?.length) {
          parts.push(`Newly flagged: ${data.newlyFlagged.join(", ")}.`);
        }
        if (data.cleared?.length) {
          parts.push(`No longer flagged: ${data.cleared.join(", ")}.`);
        }
      }
      setNotice({ kind: "info", text: parts.join(" ") });
      await load({ fresh: true });
    } catch {
      setNotice({ kind: "error", text: "The re-scan could not run." });
    } finally {
      setRescanning(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setNotice(null);

    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/knowledge/documents", { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setNotice({
            kind: "error",
            text: body?.error || `${file.name} could not be uploaded.`,
          });
        }
      } catch {
        setNotice({ kind: "error", text: `${file.name} could not be uploaded.` });
      }
    }

    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
    await load({ fresh: true });
  };

  return (
    <div className="kb-page">
      <header className="kb-header">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Base</h1>
          <p className="text-sm text-text-secondary">
            Procedures, policies and reference material DAVIS answers from — never figures.
          </p>
        </div>
        <Link href="/knowledge/browse" className="kb-browse-link">
          Open help centre
        </Link>
      </header>

      {counts && (
        <div className="kb-counts">
          <div className="kb-count">
            <span className="kb-count-value">{counts.published}</span>
            <span className="kb-count-label">Published articles</span>
          </div>
          <div className="kb-count">
            <span className="kb-count-value">{counts.documents}</span>
            <span className="kb-count-label">Source documents</span>
          </div>
          {counts.failed > 0 && (
            <div className="kb-count kb-count-bad">
              <span className="kb-count-value">{counts.failed}</span>
              <span className="kb-count-label">Failed to ingest</span>
            </div>
          )}
          {counts.sensitiveFlagged > 0 && (
            <div className="kb-count kb-count-warn">
              <span className="kb-count-value">{counts.sensitiveFlagged}</span>
              <span className="kb-count-label">Flagged for personal data</span>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className={notice.kind === "error" ? "kb-notice kb-notice-error" : "kb-notice"}>
          {notice.text}
        </div>
      )}

      <div className="kb-tabs">
        <button
          className={tab === "documents" ? "kb-tab is-active" : "kb-tab"}
          onClick={() => setTab("documents")}
        >
          Documents ({documents.length})
        </button>
        <button
          className={tab === "articles" ? "kb-tab is-active" : "kb-tab"}
          onClick={() => setTab("articles")}
        >
          Articles ({articles.length})
        </button>
      </div>

      {tab === "documents" ? (
        <>
          <div className="kb-upload">
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.docx,.md,.txt,.csv,.tsv,.xlsx,.xls"
              onChange={(e) => void upload(e.target.files)}
              disabled={uploading}
              className="kb-upload-input"
            />
            <p className="kb-upload-hint">
              PDF, Word, Markdown, text, CSV or Excel, up to 25MB. Spreadsheets are indexed for
              their structure, not their contents — figures come from the database.
            </p>
          </div>

          {isAdmin && documents.length > 0 && (
            <div className="kb-actions">
              <button className="kb-secondary" onClick={() => void rescan()} disabled={rescanning}>
                {rescanning ? "Re-checking…" : "Re-check for personal data"}
              </button>
              <span className="kb-row-meta">
                Runs the current rules over documents already uploaded. No re-upload, no
                re-processing.
              </span>
            </div>
          )}

          {documents.length === 0 ? (
            <p className="kb-empty">
              Nothing uploaded yet. Start with the documents your team asks about most.
            </p>
          ) : (
            <ul className="kb-list">
              {documents.map((doc) => {
                const status = STATUS_COPY[doc.status] || STATUS_COPY.PENDING;
                return (
                  <li key={doc.id} className="kb-row">
                    <div className="kb-row-main">
                      <span className="kb-row-title">{doc.name}</span>
                      <span className="kb-row-meta">
                        {bytes(doc.size)}
                        {doc.pageCount ? ` · ${doc.pageCount} pages` : ""}
                        {doc.chunkCount > 0 ? ` · ${doc.chunkCount} sections indexed` : ""}
                      </span>
                      {doc.ingestError && <p className="kb-row-error">{doc.ingestError}</p>}
                      {doc.containsSensitiveData && (
                        <p className="kb-row-warn">
                          Possible personal data: {doc.sensitiveFindings.join(", ")}. Review
                          before anything derived from this is published.
                        </p>
                      )}
                    </div>
                    <div className="kb-row-side">
                      <span className={`kb-badge ${status.tone}`}>{status.label}</span>
                      {isAdmin && (
                        <DeleteControl
                          label={`Remove ${doc.name} and everything indexed from it`}
                          busy={deleting === doc.id}
                          onDelete={() => remove("documents", doc.id, doc.name)}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="kb-actions">
            <button className="kb-primary" onClick={() => setEditorOpen(true)}>
              New article
            </button>
            {!isAdmin && (
              <span className="kb-row-meta">
                You can write drafts; an administrator publishes them.
              </span>
            )}
          </div>

          {articles.length === 0 ? (
            <p className="kb-empty">
              No articles yet. Uploaded documents are searchable on their own, but an article is
              what DAVIS can cite by name and version.
            </p>
          ) : (
            <ul className="kb-list">
              {articles.map((article) => (
                <li key={article.id} className="kb-row">
                  <div className="kb-row-main">
                    <span className="kb-row-title">{article.title}</span>
                    <span className="kb-row-meta">
                      {article.path} · {KIND_COPY[article.kind] || article.kind} · v
                      {article.version}
                      {article.sourceKind !== "MANUAL"
                        ? ` · from ${article.sourceKind.toLowerCase()}`
                        : ""}
                    </span>
                  </div>
                  <div className="kb-row-side">
                    <span
                      className={
                        article.status === "PUBLISHED"
                          ? "kb-badge kb-tone-ok"
                          : "kb-badge kb-tone-muted"
                      }
                    >
                      {article.status === "PUBLISHED" ? "Published" : "Draft"}
                    </span>
                    {isAdmin && (
                      <DeleteControl
                        label={
                          article.status === "PUBLISHED"
                            ? `Remove "${article.title}" — DAVIS will stop citing it`
                            : `Remove the draft "${article.title}"`
                        }
                        busy={deleting === article.id}
                        onDelete={() => remove("articles", article.id, article.title)}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editorOpen && (
        <ArticleEditor
          isAdmin={isAdmin}
          seed={seed}
          onClose={() => {
            setEditorOpen(false);
            setSeed(null);
          }}
          onSaved={() => {
            setEditorOpen(false);
            setSeed(null);
            void load({ fresh: true });
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

function ArticleEditor({
  isAdmin,
  seed,
  onClose,
  onSaved,
}: {
  isAdmin: boolean;
  /** Prefill from an uploaded document, when writing one up. */
  seed?: { title: string; body: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [path, setPath] = useState("");
  const [title, setTitle] = useState(seed?.title || "");
  const [kind, setKind] = useState("REFERENCE");
  const [body, setBody] = useState(seed?.body || "");
  const [steps, setSteps] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensitiveWarning, setSensitiveWarning] = useState<string[] | null>(null);

  const save = async (publish: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge/articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          title,
          kind,
          body,
          steps: kind === "PROCEDURE" ? steps : undefined,
          status: publish ? "PUBLISHED" : "DRAFT",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "The article could not be saved.");
        return;
      }
      if (data?.sensitiveWarning) {
        setSensitiveWarning(data.sensitiveWarning);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kb-modal-backdrop" onClick={onClose}>
      <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="kb-modal-title">New article</h2>

        {seed && (
          <p className="kb-field-hint">
            Started from an uploaded document. Cut it down to the part that answers a
            question — an article earns its version number by being shorter and clearer than
            the file it came from, not by copying it.
          </p>
        )}

        <label className="kb-field">
          <span>Path</span>
          <input
            className="kb-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Operations/Refunds"
          />
        </label>

        <label className="kb-field">
          <span>Title</span>
          <input
            className="kb-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issuing a refund"
          />
        </label>

        <label className="kb-field">
          <span>Kind</span>
          <select className="kb-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="REFERENCE">Reference — may be summarised</option>
            <option value="PROCEDURE">Procedure — delivered whole, in order</option>
            <option value="POLICY">Policy — quoted, never paraphrased</option>
            <option value="DEFINITION">Definition — a term and its meaning</option>
          </select>
        </label>

        <label className="kb-field">
          <span>{kind === "PROCEDURE" ? "Context and preconditions" : "Body"}</span>
          <textarea
            className="kb-input kb-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={kind === "PROCEDURE" ? 4 : 10}
          />
        </label>

        {kind === "PROCEDURE" && (
          <label className="kb-field">
            <span>Steps — one per line, in order</span>
            <textarea
              className="kb-input kb-textarea"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              rows={8}
              placeholder={"Open the record in the admin console\nSelect Issue refund\n..."}
            />
            <span className="kb-field-hint">
              Stored in order. DAVIS renders every step or none — it will never hand someone
              half a procedure.
            </span>
          </label>
        )}

        {sensitiveWarning && (
          <div className="kb-notice kb-notice-warn">
            This looks like it may contain personal data: {sensitiveWarning.join(", ")}. It was
            saved, but check it before publishing — articles are readable by everyone here.
          </div>
        )}

        {error && <div className="kb-notice kb-notice-error">{error}</div>}

        <div className="kb-modal-actions">
          <button className="kb-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="kb-secondary" onClick={() => void save(false)} disabled={saving}>
            Save draft
          </button>
          {isAdmin && (
            <button className="kb-primary" onClick={() => void save(true)} disabled={saving}>
              {saving ? "Saving…" : "Publish"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
