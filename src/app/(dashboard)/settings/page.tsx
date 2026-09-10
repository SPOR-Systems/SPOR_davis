"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * SETTINGS — API keys and who may query which tenants.
 *
 * Both tabs hand out authority, so both are written to make the consequence
 * visible at the moment of the click rather than in documentation nobody reads.
 */

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  tenant: { externalKey: string; label: string } | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  sessionsMinted: number;
}

interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: string;
  storedMode: string;
  effectiveMode: string;
  grantCount: number;
}

interface TenantLite { id: string; externalKey: string; label: string }

/**
 * A tenant's NAME is what a person recognises; its key is an identifier they
 * chose for their database. Showing only the key made these screens readable
 * to whoever set the tenants up and nobody else, so the name leads everywhere
 * and the key stays available underneath for the times it is the thing you
 * actually need to match on.
 */
function tenantName(key: string, tenants: TenantLite[]): string {
  return tenants.find((t) => t.externalKey === key)?.label || key;
}

/** A removable tenant chip: name on top, key beneath. */
function TenantChip({
  tenantKey,
  tenants,
  onRemove,
}: {
  tenantKey: string;
  tenants: TenantLite[];
  onRemove: () => void;
}) {
  const name = tenantName(tenantKey, tenants);
  return (
    <span className="adm-chip" title={tenantKey}>
      <span>
        {name}
        {name !== tenantKey && <span className="adm-chip-key">{tenantKey}</span>}
      </span>
      <span className="adm-chip-x" onClick={onRemove}>
        ×
      </span>
    </span>
  );
}

interface JoinRequest {
  id: string;
  email: string;
  name: string;
  status: string;
  note: string | null;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantAccessMode: string;
  expiresAt: string;
  expired: boolean;
}

/**
 * A dialog that floats over the page.
 *
 * The editors below used to render inline, underneath the table that opened
 * them — which meant that on a short window the panel appeared off-screen and
 * nothing visibly happened when you clicked. Centring it puts what you asked
 * for where you are already looking, and keeping the buttons in a fixed footer
 * means the action never scrolls out of reach however long the tenant list gets.
 */
function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  // Held in a ref so the effect below runs once per open. Depending on
  // `onClose` directly would re-bind the listener and re-set body overflow on
  // every keystroke in the form, which is how a restored scroll position ends
  // up being the wrong one.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    // Stop the page behind from scrolling under the dialog.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="adm-modal-backdrop"
      // mousedown rather than click: a drag that starts inside the dialog and
      // ends on the backdrop should not close it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div className="adm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="adm-modal-head">
          <div>
            <div className="adm-modal-title">{title}</div>
            {subtitle && <div className="adm-modal-sub">{subtitle}</div>}
          </div>
          <button type="button" className="adm-modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="adm-modal-body">{children}</div>
        <div className="adm-modal-foot">{footer}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<"users" | "keys" | "access">("users");
  const [pendingCount, setPendingCount] = useState(0);

  // Only fetched when the Users tab is NOT showing. While it is, the tab owns
  // the number and reports it up — two fetchers would race, and the loser
  // would put a stale count back on the badge.
  useEffect(() => {
    if (tab === "users") return;
    fetch("/api/registrations")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setPendingCount(d.pendingCount || 0))
      .catch(() => {});
  }, [tab]);
  return (
    <div className="adm-page">
      <div className="adm-head">
        <div>
          <h1 className="adm-title">Settings</h1>
          <p className="adm-sub">
            Your team, keys for connecting your own app, and who can see which
            tenants.
          </p>
        </div>
      </div>

      <div className="adm-tabs">
        <button
          className={`adm-tab ${tab === "users" ? "adm-tab-active" : ""}`}
          onClick={() => setTab("users")}
        >
          Users{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
        <button
          className={`adm-tab ${tab === "keys" ? "adm-tab-active" : ""}`}
          onClick={() => setTab("keys")}
        >
          API keys
        </button>
        <button
          className={`adm-tab ${tab === "access" ? "adm-tab-active" : ""}`}
          onClick={() => setTab("access")}
        >
          Tenant access
        </button>
      </div>

      {tab === "users" ? (
        // The tab already fetches the requests, so it reports the count back
        // rather than the parent polling for it — which is why the badge used
        // to keep showing someone who had just been let in.
        <UsersTab onPendingCount={setPendingCount} />
      ) : tab === "keys" ? (
        <KeysTab />
      ) : (
        <AccessTab />
      )}
    </div>
  );
}

/* ========================================================================== */

function KeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [tenants, setTenants] = useState<TenantLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [tenantKey, setTenantKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [k, t] = await Promise.all([
        fetch("/api/keys").then((r) => r.json()),
        fetch("/api/tenants?take=500").then((r) => r.json()),
      ]);
      setKeys(k.keys || []);
      setTenants(t.tenants || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    setNotice(null);
    setSecret(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tenantKey: tenantKey || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not create the key." });
        return;
      }
      setSecret(data.secret);
      setName("");
      setTenantKey("");
      load();
    } finally {
      setCreating(false);
    }
  };

  const rotate = async (key: ApiKey) => {
    const res = await fetch(`/api/keys/${key.id}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setNotice({ kind: "error", text: data?.error || "Could not replace that key." });
      return;
    }
    setSecret(data.secret);
    setNotice({ kind: "warn", text: data.warning });
    load();
  };

  const revoke = async (key: ApiKey) => {
    const res = await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
    const data = await res.json();
    setArmed(null);
    if (!res.ok) {
      setNotice({ kind: "error", text: data?.error || "Could not turn that key off." });
      return;
    }
    setNotice({
      kind: "ok",
      text:
        data.sessionsRevoked > 0
          ? `Turned off. ${data.sessionsRevoked} session(s) using this key were signed out too.`
          : "Turned off.",
    });
    load();
  };

  return (
    <>
      {notice && (
        <div
          className={`adm-notice ${
            notice.kind === "error" ? "adm-notice-error" : notice.kind === "warn" ? "adm-notice-warn" : "adm-notice-ok"
          }`}
        >
          {notice.text}
        </div>
      )}

      {secret && (
        <div className="adm-notice adm-notice-warn">
          <strong>Copy this now — it will not be shown again.</strong>
          <div className="adm-secret">{secret}</div>
          Save it somewhere safe. Keep it on your server — never put it in a
          website&apos;s code, where anyone could read it.
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setSecret(null)}>
              I have copied it
            </button>
          </div>
        </div>
      )}

      <div className="adm-card">
        <div className="adm-card-title">Create a key</div>
        <p className="adm-card-note">
          An <strong>organization</strong> key works for every tenant — one key
          for an app that serves all of them. A <strong>tenant</strong> key works
          for one tenant only, so if it ever leaks, only that customer is
          affected.
        </p>
        <div className="adm-row">
          <div className="adm-field">
            <label className="adm-field-label">Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Our main app"
            />
            <p className="adm-field-hint">
              So you can tell later what this key is for.
            </p>
          </div>
          <div className="adm-field">
            <label className="adm-field-label">Scope</label>
            <select className="input" value={tenantKey} onChange={(e) => setTenantKey(e.target.value)}>
              <option value="">All tenants</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.externalKey}>
                  {t.label} ({t.externalKey})
                </option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={create} disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create key"}
        </button>
      </div>

      <div className="adm-card">
        <div className="adm-card-title">Keys</div>
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scope</th>
                <th>Last used</th>
                <th className="adm-num">Sessions</th>
                <th style={{ width: "1%" }} />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={{ opacity: k.revokedAt ? 0.5 : 1 }}>
                  <td className="adm-strong">{k.name}</td>
                  <td className="adm-key">{k.prefix}…</td>
                  <td>
                    {k.scope === "ORGANIZATION" ? (
                      <span className="badge badge-primary">Organization</span>
                    ) : (
                      <>
                        <span className="badge badge-neutral">
                          {k.tenant?.label || k.tenant?.externalKey}
                        </span>
                        {k.tenant?.label && (
                          <div className="adm-key text-xs text-muted" style={{ marginTop: "0.2rem" }}>
                            {k.tenant.externalKey}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="text-xs">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                  </td>
                  <td className="adm-num">{k.sessionsMinted}</td>
                  <td>
                    {k.revokedAt ? (
                      <span className="text-xs text-muted">Turned off</span>
                    ) : (
                      <div className="adm-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => rotate(k)}>
                          Replace
                        </button>
                        {armed === k.id ? (
                          <button className="btn btn-danger btn-sm" onClick={() => revoke(k)}>
                            Yes, turn it off
                          </button>
                        ) : (
                          <button className="btn btn-ghost btn-sm" onClick={() => setArmed(k.id)}>
                            Turn off
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && keys.length === 0 && <div className="adm-empty">No keys yet.</div>}
          {loading && <div className="adm-empty">Loading…</div>}
        </div>
      </div>
    </>
  );
}

/* ========================================================================== */

function AccessTab() {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [tenants, setTenants] = useState<TenantLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState("NONE");
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, t] = await Promise.all([
        fetch("/api/users").then((r) => r.json()),
        fetch("/api/tenants?take=500").then((r) => r.json()),
      ]);
      setUsers(u.users || []);
      setTenants(t.tenants || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = async (u: OrgUser) => {
    setEditing(u.id);
    setMode(u.effectiveMode);
    const res = await fetch(`/api/users/access?userId=${u.id}`);
    const data = await res.json();
    setChosen((data.tenants || []).map((t: TenantLite) => t.externalKey));
  };

  const save = async () => {
    setNotice(null);
    const res = await fetch("/api/users/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: editing, mode, tenantKeys: chosen }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice({ kind: "error", text: data?.error || "Could not save." });
      return;
    }
    setEditing(null);
    setNotice({ kind: "ok", text: "Access updated." });
    load();
  };

  return (
    <>
      {notice && (
        <div className={`adm-notice ${notice.kind === "error" ? "adm-notice-error" : "adm-notice-ok"}`}>
          {notice.text}
        </div>
      )}

      <div className="adm-card">
        <div className="adm-card-title">Who can see which tenants</div>
        <p className="adm-card-note">
          Controls which tenants someone can pick from. Each question still only
          reads one tenant&apos;s data. Admins can see all tenants by default.
        </p>

        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Tenant access</th>
                <th style={{ width: "1%" }} />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="adm-strong">
                    {u.name}
                    <div className="text-xs text-muted">{u.email}</div>
                  </td>
                  <td className="text-xs">{u.role}</td>
                  <td>
                    {u.effectiveMode === "ALL" ? (
                      <span className="badge badge-warning">All tenants</span>
                    ) : u.effectiveMode === "LIST" ? (
                      <span className="badge badge-primary">{u.grantCount} tenant(s)</span>
                    ) : (
                      <span className="badge badge-neutral">None</span>
                    )}
                    {u.role === "ADMIN" && u.storedMode === "NONE" && (
                      <div className="text-xs text-muted" style={{ marginTop: "0.2rem" }}>
                        as an admin
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => open(u)}>
                      Change
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="adm-empty">Loading…</div>}
        </div>
      </div>

      {editing && (
        <Modal
          title={users.find((u) => u.id === editing)?.name || "Tenant access"}
          subtitle="Which tenants this person can pick from. Each question still reads only one tenant's data."
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={save}>
                Save
              </button>
            </>
          }
        >
          <div className="adm-field">
            <label className="adm-field-label">Access</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="NONE">No access</option>
              <option value="LIST">Only the tenants I pick</option>
              <option value="ALL">All tenants</option>
            </select>
          </div>

          {mode === "LIST" && (
            <div className="adm-field">
              <label className="adm-field-label">Tenants</label>
              <select
                className="input"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && !chosen.includes(v)) setChosen([...chosen, v]);
                }}
              >
                <option value="">Add a tenant…</option>
                {tenants
                  .filter((t) => !chosen.includes(t.externalKey))
                  .map((t) => (
                    <option key={t.id} value={t.externalKey}>
                      {t.label} ({t.externalKey})
                    </option>
                  ))}
              </select>
              <div className="adm-chips">
                {chosen.map((k) => (
                  <TenantChip
                    key={k}
                    tenantKey={k}
                    tenants={tenants}
                    onRemove={() => setChosen(chosen.filter((c) => c !== k))}
                  />
                ))}
                {chosen.length === 0 && (
                  <span className="text-xs text-muted">
                    Pick at least one, or choose &ldquo;No access&rdquo; instead.
                  </span>
                )}
              </div>
            </div>
          )}

        </Modal>
      )}
    </>
  );
}

/* ========================================================================== */

/**
 * USERS — who is here, who is asking to be, and who has been invited.
 *
 * Access is chosen at the moment someone is let in, never afterwards. Admitting
 * a person first and setting their access as a second step leaves a window
 * where it is whatever the default happens to be, and defaults are what people
 * forget to change.
 */
function UsersTab({ onPendingCount }: { onPendingCount: (n: number) => void }) {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [tenants, setTenants] = useState<TenantLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);

  // One shared access editor, used both to approve a request and to invite.
  const [target, setTarget] = useState<{ kind: "approve" | "invite"; id?: string; name?: string } | null>(null);
  const [role, setRole] = useState("MEMBER");
  const [mode, setMode] = useState("NONE");
  const [chosen, setChosen] = useState<string[]>([]);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, i, t] = await Promise.all([
        fetch("/api/registrations").then((x) => (x.ok ? x.json() : { requests: [] })),
        fetch("/api/invites").then((x) => (x.ok ? x.json() : { invites: [] })),
        fetch("/api/tenants?take=500").then((x) => (x.ok ? x.json() : { tenants: [] })),
      ]);
      const rows: JoinRequest[] = r.requests || [];
      setRequests(rows);
      setInvites(i.invites || []);
      setTenants(t.tenants || []);
      onPendingCount(rows.filter((x) => x.status === "PENDING").length);
    } finally {
      setLoading(false);
    }
  }, [onPendingCount]);

  useEffect(() => { load(); }, [load]);

  const reset = () => {
    setTarget(null);
    setRole("MEMBER");
    setMode("NONE");
    setChosen([]);
    setInviteName("");
    setInviteEmail("");
  };

  const approve = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target?.id, action: "approve", role, tenantAccessMode: mode, tenantKeys: chosen }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not approve." });
        return;
      }
      setNotice({ kind: "ok", text: `${data.user.name} can now sign in.` });
      reset();
      load();
    } finally {
      setBusy(false);
    }
  };

  const deny = async (r: JoinRequest) => {
    const res = await fetch("/api/registrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, action: "deny" }),
    });
    if (res.ok) {
      setNotice({ kind: "ok", text: `${r.name}'s request was turned down.` });
      load();
    }
  };

  const invite = async () => {
    setBusy(true);
    setNotice(null);
    setLink(null);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: inviteName,
          email: inviteEmail,
          role,
          tenantAccessMode: mode,
          tenantKeys: chosen,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data?.error || "Could not create the invitation." });
        return;
      }
      setLink(`${window.location.origin}/join/${data.token}`);
      reset();
      load();
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (i: Invite) => {
    const res = await fetch(`/api/invites?id=${i.id}`, { method: "DELETE" });
    if (res.ok) {
      setNotice({ kind: "ok", text: `The invitation for ${i.name} was cancelled.` });
      load();
    }
  };

  const pending = requests.filter((r) => r.status === "PENDING");

  return (
    <>
      {notice && (
        <div className={`adm-notice ${notice.kind === "error" ? "adm-notice-error" : "adm-notice-ok"}`}>
          {notice.text}
        </div>
      )}

      {link && (
        <div className="adm-notice adm-notice-warn">
          <strong>Send this link to the person you invited.</strong>
          <div className="adm-secret">{link}</div>
          It works once and expires in 7 days. It won&apos;t be shown again — cancel
          the invitation and make a new one if you lose it.
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setLink(null)}>
              I&apos;ve copied it
            </button>
          </div>
        </div>
      )}

      {/* ── Waiting to join ─────────────────────────────────────────────── */}
      <div className="adm-card">
        <div className="adm-card-title">
          Waiting to join{pending.length > 0 ? ` (${pending.length})` : ""}
        </div>
        <p className="adm-card-note">
          People who signed up and asked to join your organization. They
          can&apos;t sign in until you let them in, and you choose what they can
          see at that point.
        </p>

        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Asked</th>
                <th style={{ width: "1%" }} />
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td className="adm-strong">
                    {r.name}
                    <div className="text-xs text-muted">{r.email}</div>
                  </td>
                  <td className="text-xs">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div className="adm-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => { reset(); setTarget({ kind: "approve", id: r.id, name: r.name }); }}
                      >
                        Let them in
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => deny(r)}>
                        Turn down
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && pending.length === 0 && (
            <div className="adm-empty">Nobody is waiting.</div>
          )}
          {loading && <div className="adm-empty">Loading…</div>}
        </div>
      </div>

      {/* ── Invitations ─────────────────────────────────────────────────── */}
      <div className="adm-card">
        <div className="adm-card-title">Invitations</div>
        <p className="adm-card-note">
          Add someone yourself and send them a link. No email is sent — you copy
          the link and pass it on however you like.
        </p>

        {invites.length > 0 && (
          <div className="adm-table-wrap" style={{ marginBottom: "var(--space-4)" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Will join as</th>
                  <th>Expires</th>
                  <th style={{ width: "1%" }} />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id} style={{ opacity: i.expired ? 0.5 : 1 }}>
                    <td className="adm-strong">
                      {i.name}
                      <div className="text-xs text-muted">{i.email}</div>
                    </td>
                    <td className="text-xs">
                      {i.role === "ADMIN" ? "Admin" : "Member"} ·{" "}
                      {i.tenantAccessMode === "ALL"
                        ? "all tenants"
                        : i.tenantAccessMode === "LIST"
                        ? "chosen tenants"
                        : "no tenants"}
                    </td>
                    <td className="text-xs">
                      {i.expired ? "Expired" : new Date(i.expiresAt).toLocaleDateString()}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => revokeInvite(i)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <button
          className="btn btn-secondary btn-sm"
          onClick={() => { reset(); setTarget({ kind: "invite" }); }}
        >
          Invite someone
        </button>
      </div>

      {/* ── The shared access editor, floating over the page ────────────── */}
      {target && (
        <Modal
          title={target.kind === "approve" ? `Let ${target.name} in` : "Invite someone"}
          subtitle={
            target.kind === "approve"
              ? "Choose what they can see. This is the only step — they'll sign in with the password they already picked."
              : "You'll get a link to send them. Their access is set now, before they join."
          }
          onClose={reset}
          footer={
            <>
              <button className="btn btn-ghost btn-sm" onClick={reset}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={target.kind === "approve" ? approve : invite}
              >
                {busy
                  ? "Working…"
                  : target.kind === "approve"
                  ? "Let them in"
                  : "Create invitation"}
              </button>
            </>
          }
        >
          {target.kind === "invite" && (
            <div className="adm-row">
              <div className="adm-field">
                <label className="adm-field-label">Name</label>
                <input className="input" value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
              </div>
              <div className="adm-field">
                <label className="adm-field-label">Email</label>
                <input
                  className="input"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="adm-row">
            <div className="adm-field">
              <label className="adm-field-label">Role</label>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
              <p className="adm-field-hint">
                Admins can change settings and see every tenant.
              </p>
            </div>

            <div className="adm-field">
              <label className="adm-field-label">Which tenants they can see</label>
              <select
                className="input"
                value={role === "ADMIN" ? "ALL" : mode}
                disabled={role === "ADMIN"}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="NONE">No access</option>
                <option value="LIST">Only the tenants I pick</option>
                <option value="ALL">All tenants</option>
              </select>
              {role === "ADMIN" && (
                <p className="adm-field-hint">Admins always see all tenants.</p>
              )}
            </div>
          </div>

          {role !== "ADMIN" && mode === "LIST" && (
            <div className="adm-field">
              <label className="adm-field-label">Tenants</label>
              <select
                className="input"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && !chosen.includes(v)) setChosen([...chosen, v]);
                }}
              >
                <option value="">Add a tenant…</option>
                {tenants
                  .filter((t) => !chosen.includes(t.externalKey))
                  .map((t) => (
                    <option key={t.id} value={t.externalKey}>
                      {t.label} ({t.externalKey})
                    </option>
                  ))}
              </select>
              <div className="adm-chips">
                {chosen.map((k) => (
                  <TenantChip
                    key={k}
                    tenantKey={k}
                    tenants={tenants}
                    onRemove={() => setChosen(chosen.filter((c) => c !== k))}
                  />
                ))}
                {chosen.length === 0 && (
                  <span className="text-xs text-muted">
                    Pick at least one, or choose &ldquo;No access&rdquo; instead.
                  </span>
                )}
              </div>
            </div>
          )}

        </Modal>
      )}
    </>
  );
}
