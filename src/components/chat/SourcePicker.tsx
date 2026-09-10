"use client";

import { useEffect, useRef, useState } from "react";

/**
 * WHAT THIS QUESTION IS ABOUT — one control, not two.
 *
 * There used to be a tenant dropdown and a database dropdown side by side, and
 * nothing stopped you setting them to disagree: "DemoTenant1" against a
 * completely unrelated database. The server refuses that now, but the deeper
 * problem was the interface asking two questions that only ever had one answer.
 *
 * A tenant IS a database. So there is one list:
 *
 *   - each tenant you can reach, showing the database it uses;
 *   - for admins, databases that no tenant has claimed yet;
 *   - the knowledge base on its own.
 *
 * Picking one sets both halves together, so they cannot drift apart. And when
 * there is only one thing to pick, it renders as a label rather than a menu —
 * a dropdown with one option only ever wastes a click.
 */

export interface ChatSource {
  kind: "tenant" | "database" | "knowledge";
  /** Sent as tenantKey. Absent for a plain database or the knowledge base. */
  tenantKey?: string;
  tenantId?: string;
  /** Sent as connectionId. Absent for the knowledge base. */
  connectionId?: string;
  label: string;
  sublabel?: string;
}

const KNOWLEDGE: ChatSource = {
  kind: "knowledge",
  label: "Knowledge base only",
  sublabel: "Answer from documents, not a database",
};

export default function SourcePicker({
  value,
  onChange,
  isAdmin,
  disabled,
}: {
  value: ChatSource | null;
  onChange: (source: ChatSource) => void;
  isAdmin: boolean;
  disabled?: boolean;
}) {
  const [sources, setSources] = useState<ChatSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const chosenRef = useRef(value);
  chosenRef.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ take: "50" });
        if (query.trim()) params.set("q", query.trim());

        const [tenantRes, connRes] = await Promise.all([
          fetch(`/api/tenants/accessible?${params}`),
          // Members are refused this endpoint by design, so they never call it.
          isAdmin ? fetch("/api/connections") : Promise.resolve(null),
        ]);

        const tenantData = tenantRes.ok ? await tenantRes.json() : { tenants: [] };
        const connData = connRes && connRes.ok ? await connRes.json() : { connections: [] };

        const tenants: ChatSource[] = (tenantData.tenants || []).map((t: any) => ({
          kind: "tenant" as const,
          tenantKey: t.externalKey,
          tenantId: t.id,
          connectionId: t.connectionId || undefined,
          label: t.label,
          sublabel: t.connectionName || "No database linked",
        }));

        // A database a tenant already owns is offered as that tenant, not twice.
        const claimed = new Set(
          tenants.map((t) => t.connectionId).filter(Boolean) as string[]
        );
        const spare: ChatSource[] = (connData.connections || [])
          .filter((c: any) => !claimed.has(c.id))
          .map((c: any) => ({
            kind: "database" as const,
            connectionId: c.id,
            label: c.name,
            sublabel: c.type,
          }));

        const all = [...tenants, ...spare, KNOWLEDGE];
        setSources(all);
        setLoaded(true);

        // Nothing chosen yet: take the first real source, so someone with one
        // clinic never has to make a choice they do not have.
        if (!chosenRef.current && !query.trim()) {
          const first = all.find((s) => s.kind !== "knowledge");
          if (first) changeRef.current(first);
        }
      } catch {
        setLoaded(true);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, isAdmin]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  if (!loaded) return null;

  const real = sources.filter((s) => s.kind !== "knowledge");

  // One tenant and the knowledge base is not a choice worth a menu.
  if (!isAdmin && real.length <= 1 && !query.trim()) {
    const only = value || real[0];
    if (!only) {
      return <span className="chat-bar-label">No data access yet</span>;
    }
    return (
      <span className="tp-fixed" title={only.sublabel}>
        <span className="tp-fixed-dot" />
        {only.label}
      </span>
    );
  }

  const pick = (s: ChatSource) => {
    onChange(s);
    setOpen(false);
    setQuery("");
  };

  const tenants = sources.filter((s) => s.kind === "tenant");
  const spare = sources.filter((s) => s.kind === "database");

  return (
    <div className="tp" ref={boxRef}>
      <button
        type="button"
        className="tp-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="What this question is about"
      >
        <span className="tp-btn-label">{value ? value.label : "Choose what to ask about"}</span>
        <span className="tp-caret">▾</span>
      </button>

      {open && (
        <div className="tp-menu">
          <input
            className="input tp-search"
            autoFocus
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {tenants.length > 0 && <div className="tp-group">Tenants</div>}
          {tenants.map((s) => (
            <button
              key={s.tenantId}
              type="button"
              className={`tp-item ${value?.tenantId === s.tenantId ? "tp-item-active" : ""}`}
              onClick={() => pick(s)}
            >
              <div>{s.label}</div>
              <div className="tp-item-key">{s.sublabel}</div>
            </button>
          ))}

          {spare.length > 0 && <div className="tp-group">Databases with no tenant</div>}
          {spare.map((s) => (
            <button
              key={s.connectionId}
              type="button"
              className={`tp-item ${
                value?.kind === "database" && value.connectionId === s.connectionId
                  ? "tp-item-active"
                  : ""
              }`}
              onClick={() => pick(s)}
            >
              <div>{s.label}</div>
              <div className="tp-item-key">{s.sublabel}</div>
            </button>
          ))}

          <div className="tp-group">Documents</div>
          <button
            type="button"
            className={`tp-item ${value?.kind === "knowledge" ? "tp-item-active" : ""}`}
            onClick={() => pick(KNOWLEDGE)}
          >
            <div>{KNOWLEDGE.label}</div>
            <div className="tp-item-key">{KNOWLEDGE.sublabel}</div>
          </button>

          {tenants.length === 0 && spare.length === 0 && (
            <div className="tp-empty">
              {query ? `Nothing matches “${query}”.` : "No databases available to you."}
            </div>
          )}

          <div className="tp-note">Switching starts a new chat.</div>
        </div>
      )}
    </div>
  );
}
