"use client";

import { useState, useEffect } from "react";
import AddConnectionModal, { DatabaseConnection } from "@/components/connections/AddConnectionModal";

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    try {
      const res = await fetch("/api/connections");
      if (res.ok) {
        const data = await res.json();
        setConnections(data.connections);
      }
    } catch (error) {
      console.error("Failed to fetch connections", error);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectionAdded = (newConnection: DatabaseConnection) => {
    setConnections([newConnection, ...connections]);
  };

  const [armed, setArmed] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const removeConnection = async (id: string, name: string) => {
    setDeleting(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice(data?.error || `${name} could not be removed.`);
        return;
      }
      setConnections((prev) => prev.filter((c) => c.id !== id));
      // Past answers survive a deleted connection but lose the link back to
      // it. Saying how many is more useful than a bare "deleted".
      if (data?.messagesUnlinked > 0) {
        setNotice(
          `${name} removed. ${data.messagesUnlinked} past answer${
            data.messagesUnlinked === 1 ? "" : "s"
          } kept their figures but no longer link back to it.`
        );
      }
    } catch {
      setNotice(`${name} could not be removed.`);
    } finally {
      setDeleting(null);
      setArmed(null);
    }
  };

  const getDbLogo = (type: string) => {
    switch (type) {
      case "POSTGRESQL": return { abbr: "PG", color: "#336791" };
      case "MYSQL": return { abbr: "My", color: "#4479A1" };
      case "MSSQL": return { abbr: "MS", color: "#CC2927" };
      case "ORACLE": return { abbr: "Or", color: "#F80000" };
      case "MONGODB": return { abbr: "Mg", color: "#47A248" };
      case "SQLITE": return { abbr: "SL", color: "#003B57" };
      case "MARIADB": return { abbr: "Ma", color: "#003545" };
      default: return { abbr: "DB", color: "#6b7280" };
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "CONNECTED":
        return <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-success/10 text-success border border-success/20">Connected</span>;
      case "DISCONNECTED":
        return <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted border border-text-muted/20">Disconnected</span>;
      case "ERROR":
        return <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-danger/10 text-danger border border-danger/20">Error</span>;
      case "TESTING":
        return <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-brand-primary/10 text-brand-primary border border-brand-primary/20">Testing...</span>;
      default:
        return <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted border border-text-muted/20">{status}</span>;
    }
  };

  return (
    <>
      <div className="animate-fade-in">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Database Connections</h1>
            <p className="text-text-secondary">
              Manage the enterprise databases that DAVIS can securely query.
            </p>
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="btn btn-primary flex items-center gap-2"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Connection
          </button>
        </div>

        {notice && <div className="kb-notice" style={{ marginBottom: "1rem" }}>{notice}</div>}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="typing-indicator scale-150">
              <span /><span /><span />
            </div>
          </div>
        ) : connections.length === 0 ? (
          <div className="bg-bg-surface border border-border-default border-dashed rounded-xl p-12 text-center flex flex-col items-center">
            <div className="w-16 h-16 bg-bg-elevated rounded-full flex items-center justify-center text-text-muted mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5V19A9 3 0 0 0 21 19V5" />
                <path d="M3 12A9 3 0 0 0 21 12" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2">No databases connected yet</h3>
            <p className="text-text-secondary max-w-sm mb-6">
              Connect your first database to allow DAVIS to analyze your data and answer questions.
            </p>
            <button
              onClick={() => setIsModalOpen(true)}
              className="btn btn-primary"
            >
              Add Your First Database
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {connections.map((conn) => {
              const logo = getDbLogo(conn.type);
              return (
                <div key={conn.id} className="bg-bg-surface border border-border-subtle rounded-xl p-6 hover:border-brand-primary/30 transition-colors shadow-sm relative group" style={{ backgroundColor: "#363737" }} >
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-4">
                      <div
                        className="w-12 h-12 rounded-md flex items-center justify-center font-bold text-white shadow-sm"
                        style={{ backgroundColor: logo.color, padding: "0.25rem" }}
                      >
                        {logo.abbr}
                      </div>
                      <div>
                        <h3 className="font-semibold text-lg">{conn.name}</h3>
                        <p className="text-sm text-text-muted">{conn.database} @ {conn.host}:{conn.port}</p>
                      </div>
                    </div>
                    {getStatusBadge(conn.status)}
                  </div>

                  <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-border-subtle">
                    <div>
                      <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Username</p>
                      <p className="text-sm font-medium">{conn.username}</p>
                    </div>
                    <div>
                      <p className="text-xs text-text-muted uppercase tracking-wider mb-1">Added On</p>
                      <p className="text-sm font-medium">{new Date(conn.createdAt).toLocaleDateString()}</p>
                    </div>
                  </div>

                  {/* Removing a connection revokes DAVIS's access to that
                      database. It does not touch the database itself, and past
                      answers keep their figures — so the confirmation says
                      exactly that rather than a generic "are you sure". */}
                  <div className="conn-actions">
                    {armed === conn.id ? (
                      <span className="kb-confirm">
                        <span className="kb-confirm-text">
                          Remove DAVIS&apos;s access to {conn.name}? The database itself is
                          untouched.
                        </span>
                        <button
                          type="button"
                          className="kb-delete kb-delete-armed"
                          onClick={() => void removeConnection(conn.id, conn.name)}
                          disabled={deleting === conn.id}
                        >
                          {deleting === conn.id ? "Removing…" : "Yes, remove"}
                        </button>
                        <button
                          type="button"
                          className="kb-secondary"
                          onClick={() => setArmed(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="kb-delete"
                        onClick={() => setArmed(conn.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AddConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleConnectionAdded}
      />
    </>
  );
}
