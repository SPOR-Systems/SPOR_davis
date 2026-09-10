"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * USAGE
 *
 * Two things an integrator needs from this page: what they will be billed for
 * (a count of active tenants), and whether anything is running away from them
 * (an overage, while it is accruing rather than at month end).
 *
 * The meter counts PROVIDER CALLS, not questions, because they diverge: a
 * knowledge question on the fast path skips planning entirely, and one needing
 * three repair rounds costs four. Counting questions would hide both.
 */

interface Row {
  tenantId: string;
  externalKey: string;
  label: string;
  status: string;
  questions: number;
  providerCalls: number;
  refusals: number;
  allowance: number | null;
  overage: number;
}

interface Summary {
  period: string;
  billableTenants: number;
  tenantsOverAllowance: number;
  totals: { questions: number; providerCalls: number; refusals: number; overage: number };
  tenants: Row[];
}

function monthOptions(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export default function UsagePage() {
  const [period, setPeriod] = useState(monthOptions()[0]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage?period=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (res.ok) setSummary(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  const sweep = async () => {
    setSweeping(true);
    setNotice(null);
    try {
      const res = await fetch("/api/usage", { method: "POST" });
      const data = await res.json();
      setNotice(
        res.ok
          ? `Checked ${data.tenantsConsidered} tenant(s) with a limit set. Deleted ${data.sessionsDeleted} chat(s).`
          : data?.error || "That could not be run right now."
      );
    } finally {
      setSweeping(false);
    }
  };

  const rows = summary?.tenants ?? [];
  const busiest = Math.max(1, ...rows.map((r) => r.providerCalls));

  return (
    <div className="adm-page">
      <div className="adm-head">
        <div>
          <h1 className="adm-title">Usage</h1>
          <p className="adm-sub">
            Usage is charged to whichever customer&apos;s data was read, no matter
            who asked. Going over the included amount doesn&apos;t stop answers —
            the extra is billed.
          </p>
        </div>
        <div className="adm-actions">
          <select
            className="input"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{ width: "auto" }}
          >
            {monthOptions().map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {notice && <div className="adm-notice">{notice}</div>}

      {summary && (
        <div className="adm-stats">
          <div className="adm-stat">
            <div className="adm-stat-label">Billable tenants</div>
            <div className="adm-stat-value">{summary.billableTenants}</div>
            <div className="adm-stat-foot">Not paused</div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">Questions</div>
            <div className="adm-stat-value">{summary.totals.questions.toLocaleString()}</div>
            <div className="adm-stat-foot">{summary.totals.refusals.toLocaleString()} refused</div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">AI requests</div>
            <div className="adm-stat-value">{summary.totals.providerCalls.toLocaleString()}</div>
            <div className="adm-stat-foot">What you&apos;re billed for</div>
          </div>
          <div className="adm-stat">
            <div className="adm-stat-label">Over their limit</div>
            <div className="adm-stat-value">{summary.tenantsOverAllowance}</div>
            <div className="adm-stat-foot">
              {summary.totals.overage > 0
                ? `${summary.totals.overage.toLocaleString()} extra requests`
                : "Everyone within limit"}
            </div>
          </div>
        </div>
      )}

      <div className="adm-card">
        <div className="adm-card-title">By tenant · {summary?.period ?? period}</div>
        <p className="adm-card-note">
          Tenants with no activity are still listed — they&apos;re billed for
          being active, not for being used.
        </p>

        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Status</th>
                <th className="adm-num">Questions</th>
                <th className="adm-num">AI requests</th>
                <th style={{ width: "140px" }}>Against limit</th>
                <th className="adm-num">Extra</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = r.allowance
                  ? Math.min(100, (r.providerCalls / r.allowance) * 100)
                  : 0;
                return (
                  <tr key={r.tenantId}>
                    <td className="adm-strong">
                      {r.label}
                      <div className="adm-key text-xs text-muted">{r.externalKey}</div>
                    </td>
                    <td>
                      <span className={`badge ${r.status === "ACTIVE" ? "badge-success" : "badge-neutral"}`}>
                        {r.status === "ACTIVE" ? "Active" : "Paused"}
                      </span>
                    </td>
                    <td className="adm-num">{r.questions.toLocaleString()}</td>
                    <td className="adm-num">{r.providerCalls.toLocaleString()}</td>
                    <td>
                      {r.allowance === null ? (
                        <span className="text-xs text-muted">No limit</span>
                      ) : (
                        <>
                          <div className="adm-meter">
                            <div
                              className={`adm-meter-fill ${r.overage > 0 ? "adm-meter-over" : ""}`}
                              style={{ width: `${r.overage > 0 ? 100 : pct}%` }}
                            />
                          </div>
                          <div className="text-xs text-muted" style={{ marginTop: "0.25rem" }}>
                            {r.providerCalls.toLocaleString()} / {r.allowance.toLocaleString()}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="adm-num">
                      {r.overage > 0 ? (
                        <span className="text-warning">+{r.overage.toLocaleString()}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <div className="adm-empty">No tenants yet.</div>
          )}
          {loading && <div className="adm-empty">Loading…</div>}
        </div>
      </div>

      <div className="adm-card">
        <div className="adm-card-title">Deleting old chats</div>
        <p className="adm-card-note">
          Deletes chats older than each tenant&apos;s limit. Safe to run any time
          — use it when a customer asks for their data to be removed.
        </p>
        <button className="btn btn-secondary btn-sm" onClick={sweep} disabled={sweeping}>
          {sweeping ? "Deleting…" : "Delete old chats now"}
        </button>
      </div>
    </div>
  );
}
