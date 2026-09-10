"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * ROW-LEVEL SCOPING for one connection.
 *
 * This screen leads with the verification state rather than the form, because
 * the dangerous state is not "misconfigured" — it is "misconfigured and
 * believed to be fine". A scoped connection that has not proven it isolates
 * refuses to answer, and the page should make that obvious before anyone goes
 * looking for why the widget is quiet.
 */

interface ScopeState {
  mode: string;
  column: string | null;
  setting: string | null;
  tables: string[];
  verifiedAt: string | null;
  verifyNote: string | null;
  exposedObjects: string[];
  managedViewsSupported: boolean;
}

interface Check {
  name: string;
  passed: boolean | null;
  detail: string;
}

const MODES = [
  {
    id: "NONE",
    name: "No separation",
    blurb:
      "Every question can see the whole database. Fine for your own team. Not safe if customers will use it.",
  },
  {
    id: "MANAGED_VIEWS",
    name: "One database, with a column naming the customer",
    blurb:
      "Everyone's data sits in the same tables, and a column says who each row belongs to. DAVIS shows only the matching rows and cannot see the rest.",
  },
  {
    id: "NATIVE_RLS",
    name: "My database already does the filtering",
    blurb:
      "Your database has security rules that limit what each user sees. DAVIS tells it who is asking and lets it do the rest.",
  },
  {
    id: "SEPARATE_CREDENTIALS",
    name: "Each customer has its own database or login",
    blurb:
      "They are already kept apart. DAVIS signs in with the right one for whoever is asking.",
  },
];

export default function ScopePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;

  const [scope, setScope] = useState<ScopeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const [mode, setMode] = useState("NONE");
  const [column, setColumn] = useState("");
  const [setting, setSetting] = useState("");
  const [tablesText, setTablesText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/connections/${id}/scope`);
      const data = await res.json();
      if (res.ok) {
        setScope(data.scope);
        setMode(data.scope.mode);
        setColumn(data.scope.column || "");
        setSetting(data.scope.setting || "");
        setTablesText((data.scope.tables || []).join("\n"));
      } else {
        setNotice({ kind: "error", text: data?.error || "Could not load these settings." });
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    setChecks(null);
    try {
      const tables = tablesText.split("\n").map((t) => t.trim()).filter(Boolean);
      const res = await fetch(`/api/connections/${id}/scope`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, column, setting, tables }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not save." });
        return;
      }
      await load();
      setNotice({
        kind: mode === "NONE" ? "ok" : "warn",
        text:
          mode === "NONE"
            ? "Saved. This connection now answers from the whole database."
            : "Saved. Run the test again — DAVIS won't use this connection until it passes.",
      });
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/connections/${id}/verify-scope`, { method: "POST" });
      const data = await res.json();
      setChecks(data.checks || null);
      setNotice({
        kind: data.verified ? "ok" : "error",
        text: data.note || data.error || "The check could not be completed.",
      });
      await load();
    } finally {
      setVerifying(false);
    }
  };

  if (loading) return <div className="adm-page"><div className="adm-empty">Loading…</div></div>;

  const scoped = scope && scope.mode !== "NONE";
  const verified = !!scope?.verifiedAt;

  return (
    <div className="adm-page">
      <div className="adm-head">
        <div>
          <h1 className="adm-title">Data separation</h1>
          <p className="adm-sub">
            How DAVIS keeps each of your customers from seeing another&apos;s data
            on this connection.
          </p>
        </div>
        <div className="adm-actions">
          <Link href="/connections" className="btn btn-ghost btn-sm">Back</Link>
        </div>
      </div>

      {scoped && (
        <div className={`adm-notice ${verified ? "adm-notice-ok" : "adm-notice-error"}`}>
          <strong>
            {verified ? "Tested and working" : "Not tested yet — this connection won't answer questions"}
          </strong>
          <div style={{ marginTop: "0.3rem" }}>
            {scope?.verifyNote ||
              "DAVIS has to prove each customer only sees their own data before it will use this connection."}
          </div>
          {verified && (
            <div style={{ marginTop: "0.3rem", opacity: 0.8 }}>
              Last tested {new Date(scope!.verifiedAt!).toLocaleString()}
            </div>
          )}
        </div>
      )}

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

      <div className="adm-card">
        <div className="adm-card-title">How your data is separated</div>
        <p className="adm-card-note">
          Pick what matches your database. The wrong choice here can show one
          customer another&apos;s data.
        </p>

        {MODES.map((m) => {
          const unsupported =
            m.id === "MANAGED_VIEWS" && scope && !scope.managedViewsSupported;
          return (
            <label
              key={m.id}
              className="adm-check"
              style={{ cursor: unsupported ? "not-allowed" : "pointer", opacity: unsupported ? 0.5 : 1 }}
            >
              <input
                type="radio"
                name="mode"
                className="adm-check-mark"
                checked={mode === m.id}
                disabled={!!unsupported}
                onChange={() => setMode(m.id)}
              />
              <div>
                <div className="adm-check-name">{m.name}</div>
                <div className="adm-check-detail">
                  {m.blurb}
                  {unsupported && (
                    <>
                      {" "}
                      <strong>
                        Not possible on MySQL — it can&apos;t filter this way. Use a
                        separate database or login per customer instead.
                      </strong>
                    </>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {mode !== "NONE" && (
        <div className="adm-card">
          <div className="adm-card-title">Which tables DAVIS can read</div>
          <p className="adm-card-note">
            One per line. DAVIS cannot read anything you don&apos;t list here.
          </p>
          <textarea
            className="input adm-textarea"
            value={tablesText}
            onChange={(e) => setTablesText(e.target.value)}
            placeholder={"orders\ncustomers\nline_items"}
          />

          {mode === "MANAGED_VIEWS" && (
            <div className="adm-field" style={{ marginTop: "var(--space-4)" }}>
              <label className="adm-field-label">Which column names the customer</label>
              <input
                className="input"
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                placeholder="store_code"
              />
              <p className="adm-field-hint">
                Double-check this is the right column. DAVIS can test that it
                filters consistently, but it can&apos;t tell whether you picked the
                wrong one — a region or site code would pass the test and still
                show the wrong data.
              </p>
            </div>
          )}

          {mode === "NATIVE_RLS" && (
            <>
              <div className="adm-field" style={{ marginTop: "var(--space-4)" }}>
                <label className="adm-field-label">The setting your security rules read</label>
                <input
                  className="input"
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  placeholder="davis.tenant"
                />
              </div>
              <div className="adm-field">
                <label className="adm-field-label">Which column names the customer (optional)</label>
                <input
                  className="input"
                  value={column}
                  onChange={(e) => setColumn(e.target.value)}
                  placeholder="store_code"
                />
                <p className="adm-field-hint">
                  Your database does the filtering, so DAVIS doesn&apos;t need this
                  to work. Filling it in lets the test check directly that one
                  customer can&apos;t see another&apos;s rows.
                </p>
              </div>
            </>
          )}

          {scope && scope.exposedObjects.length > 0 && mode === scope.mode && (
            <div className="adm-field">
              <label className="adm-field-label">DAVIS can read only these</label>
              <div className="adm-chips">
                {scope.exposedObjects.map((o) => (
                  <span key={o} className="adm-chip adm-key">{o}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="adm-card">
        <div className="adm-actions">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save configuration"}
          </button>
          {scoped && (
            <button className="btn btn-secondary btn-sm" onClick={verify} disabled={verifying}>
              {verifying ? "Testing…" : "Test separation"}
            </button>
          )}
        </div>
        {scoped && (
          <p className="adm-field-hint" style={{ marginTop: "var(--space-3)" }}>
            DAVIS reads the data as two of your customers and checks neither can
            see the other&apos;s. You need at least two active tenants that both
            have some data.
          </p>
        )}
      </div>

      {checks && (
        <div className="adm-card">
          <div className="adm-card-title">Test results</div>
          {checks.map((c, i) => (
            <div key={i} className="adm-check">
              <span
                className={`adm-check-mark ${
                  c.passed === true
                    ? "adm-check-pass"
                    : c.passed === false
                    ? "adm-check-fail"
                    : "adm-check-na"
                }`}
              >
                {c.passed === true ? "✓" : c.passed === false ? "✕" : "–"}
              </span>
              <div>
                <div className="adm-check-name">{c.name}</div>
                <div className="adm-check-detail">{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
