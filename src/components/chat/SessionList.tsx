"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Past conversations.
 *
 * These have been accumulating since the first release with no way to see or
 * remove them. That is worse than untidy: a conversation carries the SQL that
 * was run and the assumptions that were made, so an old one is a record someone
 * may still need — and one nobody can find is a record that only exists to take
 * up space.
 *
 * Deletion is permanent and says so. The messages go with the session, which
 * includes the metadata the gap engine reads, so removing a conversation also
 * removes the evidence of what DAVIS could not answer in it. That is a real
 * trade and the copy does not pretend otherwise.
 */

export interface SessionRow {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function when(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Deliberately in place of the delete control: you cannot delete mid-answer. */
function Spinner() {
  return (
    <span className="sess-spinner" role="status" aria-label="Generating an answer">
      <span className="sess-spinner-dot" />
    </span>
  );
}

export default function SessionList({
  activeId,
  working,
  onOpen,
  onNew,
  reloadToken,
}: {
  activeId: string | null;
  /**
   * Conversations still generating an answer.
   *
   * Without this the list gives no way to tell a finished conversation from one
   * that is mid-answer — and since a request now survives switching away, that
   * distinction is the difference between "my question vanished" and "it is
   * still thinking, over there".
   */
  working: string[];
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Bumped by the parent after a message is sent, so titles stay current. */
  reloadToken: number;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      /* the chat still works without the list */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const remove = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        // Deleting the conversation you are reading has to clear the screen
        // too, or the messages stay visible with nothing behind them.
        if (id === activeId) onNew();
      }
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  // A conversation created moments ago may not be in the fetched list yet. It
  // still needs a row, or the user watches their brand-new chat not appear.
  const known = new Set(sessions.map((s) => s.id));
  const pending = working.filter((id) => !known.has(id));

  return (
    <aside className={open ? "sess" : "sess sess-collapsed"}>
      <div className="sess-head">
        <button
          type="button"
          className="sess-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? "Hide conversations" : "Show conversations"}
        >
          {open ? "‹" : "›"}
        </button>
        {open && (
          <>
            <span className="sess-title">Conversations</span>
            <button type="button" className="sess-new" onClick={onNew}>
              New
            </button>
          </>
        )}
      </div>

      {open && (
        <ul className="sess-list">
          {pending.map((id) => (
            <li key={id} className={id === activeId ? "sess-item is-active" : "sess-item"}>
              <button type="button" className="sess-open" onClick={() => onOpen(id)}>
                <span className="sess-item-title">New conversation</span>
                <span className="sess-item-meta">Thinking…</span>
              </button>
              <Spinner />
            </li>
          ))}

          {sessions.length === 0 && pending.length === 0 ? (
            <li className="sess-empty">No conversations yet.</li>
          ) : (
            sessions.map((session) => (
              <li
                key={session.id}
                className={session.id === activeId ? "sess-item is-active" : "sess-item"}
              >
                {armed === session.id ? (
                  <div className="sess-confirm">
                    <p className="sess-confirm-text">
                      Delete this conversation and its {session.messageCount} message
                      {session.messageCount === 1 ? "" : "s"}? This cannot be undone.
                    </p>
                    <div className="sess-confirm-actions">
                      <button
                        type="button"
                        className="kb-delete kb-delete-armed"
                        onClick={() => void remove(session.id)}
                        disabled={busy === session.id}
                      >
                        {busy === session.id ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        type="button"
                        className="kb-secondary"
                        onClick={() => setArmed(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="sess-open"
                      onClick={() => onOpen(session.id)}
                    >
                      <span className="sess-item-title">{session.title}</span>
                      <span className="sess-item-meta">
                        {when(session.updatedAt)} · {session.messageCount} message
                        {session.messageCount === 1 ? "" : "s"}
                      </span>
                    </button>
                    {working.includes(session.id) ? (
                      <Spinner />
                    ) : (
                      <button
                        type="button"
                        className="sess-remove"
                        onClick={() => setArmed(session.id)}
                        aria-label={`Delete conversation: ${session.title}`}
                        title="Delete conversation"
                      >
                        ×
                      </button>
                    )}
                  </>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </aside>
  );
}
