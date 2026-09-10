"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * TENANTS
 *
 * Search-first, not a list. An EMR vendor with 800 clinics or a retailer with
 * 4,000 stores has no use for a page that tries to render all of them, and
 * paginating to page 87 is not how anyone finds a store — they know its code.
 */

interface Tenant {
  id: string;
  externalKey: string;
  label: string;
  status: string;
  connectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

const PAGE = 50;

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(
    async (search: string, offset: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ take: String(PAGE), skip: String(offset) });
        if (search.trim()) params.set("q", search.trim());
        const res = await fetch(`/api/tenants?${params}`);
        const data = await res.json();
        if (res.ok) {
          setTenants(data.tenants || []);
          setTotal(data.total || 0);
        } else {
          setNotice({ kind: "error", text: data?.error || "Could not load tenants." });
        }
      } catch {
        setNotice({ kind: "error", text: "Could not load tenants." });
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    // Debounced so typing a store code does not fire a request per keystroke.
    const t = setTimeout(() => {
      setSkip(0);
      load(query, 0);
    }, 250);
    return () => clearTimeout(t);
  }, [query, load]);

  const setStatus = async (tenant: Tenant, status: string) => {
    setBusy(tenant.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/tenants/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not update the tenant." });
        return;
      }
      setTenants((prev) =>
        prev.map((t) => (t.id === tenant.id ? { ...t, status } : t))
      );
      setNotice({
        kind: "ok",
        text:
          status === "SUSPENDED"
            ? `${tenant.externalKey} is paused. It can't be used and won't be billed.`
            : `${tenant.externalKey} is active again.`,
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (tenant: Tenant) => {
    setBusy(tenant.id);
    try {
      const res = await fetch(`/api/tenants/${tenant.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not delete the tenant." });
        return;
      }
      setTenants((prev) => prev.filter((t) => t.id !== tenant.id));
      setTotal((n) => Math.max(0, n - 1));
      setNotice({
        kind: "ok",
        text: `${tenant.externalKey} deleted, along with its chats.`,
      });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  const runImport = async () => {
    const rows = importText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // "key" or "key, Label" — a paste from a spreadsheet column, which is
        // how a list of 800 clinics actually arrives.
        const [key, ...rest] = line.split(",");
        const label = rest.join(",").trim();
        return { externalKey: key.trim(), label: label || undefined };
      });

    if (rows.length === 0) {
      setNotice({ kind: "error", text: "Nothing to import." });
      return;
    }

    setImporting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenants: rows }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 207) {
        setNotice({ kind: "error", text: data?.error || "Import failed." });
        return;
      }
      const failures = (data.results || []).filter((r: any) => !r.ok);
      setNotice({
        kind: failures.length ? "warn" : "ok",
        text:
          `${data.created} created, ${data.updated} updated` +
          (failures.length
            ? `, ${failures.length} rejected — ${failures
                .slice(0, 3)
                .map((f: any) => `${f.externalKey}: ${f.error}`)
                .join("; ")}${failures.length > 3 ? " …" : ""}`
            : "."),
      });
      if (!failures.length) {
        setShowImport(false);
        setImportText("");
      }
      load(query, skip);
    } finally {
      setImporting(false);
    }
  };

  const page = (offset: number) => {
    setSkip(offset);
    load(query, offset);
  };

  return (
    <div className="adm-page">
      <div className="adm-head">
        <div>
          <h1 className="adm-title">Tenants</h1>
          <p className="adm-sub">
            Your customers — a store, a clinic, a branch. Each one only ever
            sees its own data.
          </p>
        </div>
        <div className="adm-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => setShowImport((v) => !v)}>
            {showImport ? "Cancel" : "Add tenants"}
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`adm-notice ${
            notice.kind === "error"
              ? "adm-notice-error"
              : notice.kind === "warn"
              ? "adm-notice-warn"
              : "adm-notice-ok"
          }`}
        >
          {notice.text}
        </div>
      )}

      {showImport && (
        <div className="adm-card">
          <div className="adm-card-title">Add tenants</div>
          <p className="adm-card-note">
            One per line: an ID, or an ID and a name separated by a comma. Paste
            straight from a spreadsheet. Adding one that already exists just
            updates it.
          </p>
          <textarea
            className="input adm-textarea"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={"STORE-0001, Toronto Dundas\nSTORE-0002, Toronto Yonge\nSTORE-0003"}
          />
          <p className="adm-field-hint">
            IDs can use letters, numbers and <code>. _ - : @</code>
          </p>
          <div className="adm-actions" style={{ marginTop: "var(--space-4)" }}>
            <button className="btn btn-primary btn-sm" onClick={runImport} disabled={importing}>
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      )}

      <div className="adm-card">
        <input
          className="input adm-search"
          placeholder="Search by key or name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="adm-table-wrap" style={{ marginTop: "var(--space-4)" }}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Status</th>
                <th style={{ width: "1%" }} />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="adm-strong adm-key">
                    <Link href={`/tenants/${t.id}`} className="ks-link">
                      {t.externalKey}
                    </Link>
                  </td>
                  <td>{t.label}</td>
                  <td>
                    <span
                      className={`badge ${
                        t.status === "ACTIVE" ? "badge-success" : "badge-warning"
                      }`}
                    >
                      {t.status === "ACTIVE" ? "Active" : "Paused"}
                    </span>
                  </td>
                  <td>
                    <div className="adm-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy === t.id}
                        onClick={() =>
                          setStatus(t, t.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")
                        }
                      >
                        {t.status === "ACTIVE" ? "Pause" : "Resume"}
                      </button>
                      {armed === t.id ? (
                        <>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={busy === t.id}
                            onClick={() => remove(t)}
                          >
                            Yes, delete
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setArmed(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-ghost btn-sm" onClick={() => setArmed(t.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!loading && tenants.length === 0 && (
            <div className="adm-empty">
              {query
                ? `No tenant matches “${query}”.`
                : "No tenants yet. Add one to get started."}
            </div>
          )}
          {loading && <div className="adm-empty">Loading…</div>}
        </div>

        {total > PAGE && (
          <div
            className="flex items-center justify-between"
            style={{ marginTop: "var(--space-4)" }}
          >
            <span className="text-xs text-muted">
              {skip + 1}–{Math.min(skip + PAGE, total)} of {total}
            </span>
            <div className="adm-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={skip === 0}
                onClick={() => page(Math.max(0, skip - PAGE))}
              >
                Previous
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={skip + PAGE >= total}
                onClick={() => page(skip + PAGE)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {armed && (
        <div className="adm-notice adm-notice-warn">
          Deleting also removes this tenant&apos;s chats and keys, and can&apos;t be
          undone. Pausing is reversible — use that unless the customer has really
          gone.
        </div>
      )}
    </div>
  );
}
