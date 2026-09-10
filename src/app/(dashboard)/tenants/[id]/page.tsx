"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * One tenant: retention, credit allowance, and the keys that can act for it.
 */

interface Tenant {
  id: string;
  externalKey: string;
  label: string;
  status: string;
  retentionDays: number | null;
  creditAllowance: number | null;
  connectionId: string | null;
}

interface ConnectionLite { id: string; name: string; type: string }

interface Counts {
  sessions: number;
  schemaProfiles: number;
  activeKeys: number;
  liveEmbedSessions: number;
}

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);

  const [label, setLabel] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [connections, setConnections] = useState<ConnectionLite[]>([]);
  const [retention, setRetention] = useState("");
  const [allowance, setAllowance] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, connRes] = await Promise.all([
        fetch(`/api/tenants/${id}`),
        fetch("/api/connections"),
      ]);
      const data = await res.json();
      const connData = await connRes.json().catch(() => ({}));
      setConnections(connData.connections || []);
      if (res.ok) {
        setTenant(data.tenant);
        setConnectionId(data.tenant.connectionId || "");
        setCounts(data.counts);
        setLabel(data.tenant.label || "");
        setRetention(data.tenant.retentionDays == null ? "" : String(data.tenant.retentionDays));
        setAllowance(
          data.tenant.creditAllowance == null ? "" : String(data.tenant.creditAllowance)
        );
      } else {
        setNotice({ kind: "error", text: data?.error || "Could not load the tenant." });
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
    try {
      const body: Record<string, unknown> = { label };
      // An empty box means "no limit", which has to be sent as an explicit null
      // rather than omitted — omitting it would leave the old value in place.
      body.retentionDays = retention.trim() === "" ? null : Number(retention);
      body.creditAllowance = allowance.trim() === "" ? null : Number(allowance);
      body.connectionId = connectionId || null;

      const res = await fetch(`/api/tenants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not save." });
        return;
      }
      setTenant(data.tenant);
      setNotice({ kind: "ok", text: "Saved." });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="adm-page"><div className="adm-empty">Loading…</div></div>;
  if (!tenant) {
    return (
      <div className="adm-page">
        <div className="adm-notice adm-notice-error">{notice?.text || "Not found."}</div>
        <Link href="/tenants" className="btn btn-ghost btn-sm">Back to tenants</Link>
      </div>
    );
  }

  return (
    <div className="adm-page">
      <div className="adm-head">
        <div>
          <h1 className="adm-title">{tenant.label}</h1>
          <p className="adm-sub">
            <span className="adm-key">{tenant.externalKey}</span> ·{" "}
            <span className={tenant.status === "ACTIVE" ? "text-success" : "text-warning"}>
              {tenant.status === "ACTIVE" ? "Active" : "Paused"}
            </span>
          </p>
        </div>
        <div className="adm-actions">
          <Link href="/tenants" className="btn btn-ghost btn-sm">Back</Link>
        </div>
      </div>

      {notice && (
        <div className={`adm-notice ${notice.kind === "error" ? "adm-notice-error" : "adm-notice-ok"}`}>
          {notice.text}
        </div>
      )}

      {counts && (
        <div className="adm-stats">
          <div className="adm-stat">
            <div className="adm-stat-label">Chats</div>
            <div className="adm-stat-value">{counts.sessions}</div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">Open sessions</div>
            <div className="adm-stat-value">{counts.liveEmbedSessions}</div>
            <div className="adm-stat-foot">In use right now</div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">API keys</div>
            <div className="adm-stat-value">{counts.activeKeys}</div>
            <div className="adm-stat-foot">
              <Link href="/settings" className="ks-link">Manage</Link>
            </div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">Data snapshots</div>
            <div className="adm-stat-value">{counts.schemaProfiles}</div>
            <div className="adm-stat-foot">Kept to speed up answers</div>
          </div>
        </div>
      )}

      <div className="adm-card">
        <div className="adm-card-title">Settings</div>
        <p className="adm-card-note">
          The ID can&apos;t be changed — it&apos;s how DAVIS finds this tenant&apos;s data.
        </p>

        <div className="adm-field">
          <label className="adm-field-label">Name</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>

        <div className="adm-field">
          <label className="adm-field-label">This tenant&apos;s database</label>
          <select
            className="input"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            <option value="">Shares a database with other tenants</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
          <p className="adm-field-hint">
            If this customer has a database of their own, pick it here. Anyone
            given access to this tenant can then use that database — and only
            that one. Leave it unset when several tenants live in one shared
            database and are told apart by a column; set that up under
            Connections → Data separation instead.
          </p>
        </div>

        <div className="adm-row">
          <div className="adm-field">
            <label className="adm-field-label">Delete chats after (days)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={3650}
              value={retention}
              placeholder="Never"
              onChange={(e) => setRetention(e.target.value)}
            />
            <p className="adm-field-hint">
              Chats nobody has opened for this long are deleted. Leave blank to
              keep them forever.
            </p>
          </div>

          <div className="adm-field">
            <label className="adm-field-label">Included AI requests</label>
            <input
              className="input"
              type="number"
              min={0}
              value={allowance}
              placeholder="Uncapped"
              onChange={(e) => setAllowance(e.target.value)}
            />
            <p className="adm-field-hint">
              Going over doesn&apos;t stop answers — the extra is billed and shown
              on the Usage page. Leave blank for no limit.
            </p>
          </div>
        </div>

        <div className="adm-actions">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
