"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { DatabaseConnection } from "@/components/connections/AddConnectionModal";

import dynamic from "next/dynamic";
import type { ChartPayload } from "@/lib/ai/visualize";
import KnowledgeSources, {
  type KnowledgeSource,
} from "@/components/chat/KnowledgeSources";
import SessionList from "@/components/chat/SessionList";

/**
 * Recharts is around 90 kB of the chat bundle and most conversations start
 * with a question whose answer is a sentence. Loading it on demand keeps the
 * page fast to open, and ssr:false avoids the chart measuring itself against a
 * zero-width server render before hydration corrects it.
 */
const ResultChart = dynamic(() => import("@/components/chat/ResultChart"), {
  ssr: false,
  loading: () => <div className="chart-card chart-loading" aria-hidden="true" />,
});

import ReactMarkdown from 'react-markdown';
// Without remark-gfm, react-markdown does not implement GitHub-flavoured
// markdown — so tables, strikethrough and task lists pass through as literal
// pipe characters instead of rendering. DAVIS answers tabular results with
// markdown tables, so this plugin is required, not optional.
import remarkGfm from 'remark-gfm';

/**
 * Five different things go wrong and they need five different messages:
 *   overloaded -> Google has no capacity. Not the user's fault, retry works.
 *   quota      -> this deployment's own API limit. Retrying now won't help.
 *   config     -> a configured model ID is wrong/retired. Retrying never helps.
 *   failed     -> the question couldn't be turned into a query we trust.
 *   network    -> the browser couldn't reach the server at all.
 * Showing one generic "Error:" for all of them makes the app impossible to debug.
 */
type NoticeKind =
  | "overloaded"
  | "quota"
  | "failed"
  | "network"
  | "config"
  | "timeout";

/** One pipeline step, as reported by the server. Every entry is real work. */
interface TraceEntry {
  id: string;
  label: string;
  detail?: string;
  ms: number;
  running?: boolean;
}

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata?: any;
  noticeKind?: NoticeKind;
  retryAfterMs?: number | null;
  quotaExplanation?: string;
  freeTier?: boolean;
  /** Answer came from a fallback model, or without the prose model at all. */
  degraded?: boolean;
  proseUnavailable?: boolean;
  answerTruncated?: boolean;
  proseSkippedForQuota?: boolean;
  /** The steps DAVIS actually took, kept so the answer stays auditable. */
  trace?: TraceEntry[];
  thinkingMs?: number;
  /** The chart the server chose and shaped, or null when none fits. */
  chart?: ChartPayload | null;
  /** The row sample, kept so the export buttons know there is a result. */
  rows?: any[];
  rowCount?: number;
  /** Readings offered when DAVIS needs the question narrowed. */
  clarifyingOptions?: string[];
  /** Articles this answer was quoted from, when it came from the knowledge base. */
  knowledgeSources?: KnowledgeSource[];
  /** True when DAVIS declined to answer because nothing was documented. */
  abstained?: boolean;
}

const NOTICE_STYLES: Record<
  NoticeKind,
  { border: string; label: string }
> = {
  overloaded: {
    border: "border-warning/30 bg-warning/10 text-warning",
    label: "Google's models are busy",
  },
  quota: {
    border: "border-warning/30 bg-warning/10 text-warning",
    label: "API quota reached",
  },
  failed: {
    border: "border-danger/20 bg-danger/10 text-danger",
    label: "Couldn't answer that reliably",
  },
  network: {
    border: "border-danger/20 bg-danger/10 text-danger",
    label: "Connection problem",
  },
  config: {
    border: "border-danger/20 bg-danger/10 text-danger",
    label: "Model not configured",
  },
  timeout: {
    border: "border-warning/30 bg-warning/10 text-warning",
    label: "DAVIS stopped waiting",
  },
};

/** Live elapsed counter, so a long wait visibly progresses. */
function useElapsed(active: boolean) {
  const [ms, setMs] = useState(0);
  const startRef = useRef<number>(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setMs(0);
    const id = setInterval(() => setMs(Date.now() - startRef.current), 100);
    return () => clearInterval(id);
  }, [active]);
  return ms;
}

/** A step that took 41ms should say so, not "0.0s". */
const secs = (ms: number) =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;

/**
 * The live "thinking" panel and, once finished, the collapsed summary.
 *
 * Every line comes from a server event describing work that actually ran —
 * real table counts, the model that really served the call, real row counts,
 * the real database error when a query had to be repaired. Nothing is invented
 * to fill the silence; a progress display that fabricates activity would
 * undermine trust in the numbers themselves.
 *
 * NOTE ON STYLING: this project has no Tailwind (no dependency, no config), so
 * utility class names like `text-xs mt-3 shrink-0` are inert here. The styles
 * live in globals.css under .thinking-*, alongside .chat-bubble.
 */
function ThinkingTrace({
  trace,
  live,
  totalMs,
}: {
  trace: TraceEntry[];
  live: boolean;
  totalMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(live);

  if (trace.length === 0 && !live) return null;

  /* ---- Live: current step in focus, finished steps listed below ---- */
  if (live) {
    const active = trace.find((t) => t.running);
    const done = trace.filter((t) => !t.running);
    return (
      <div className="thinking">
        <div className="thinking-head">
          <span className="typing-indicator">
            <span /><span /><span />
          </span>
          <span className="thinking-label">
            {active ? active.label : "Thinking"}
          </span>
          <span className="thinking-elapsed">{secs(elapsed)}</span>
        </div>

        {done.length > 0 && (
          <ul className="thinking-steps">
            {done.map((t, i) => (
              <li className="thinking-step" key={`${t.id}-${i}`}>
                <span className="thinking-tick">✓</span>
                <span className="thinking-step-label">{t.label}</span>
                {t.detail && (
                  <span className="thinking-step-detail">{t.detail}</span>
                )}
                <span className="thinking-step-ms">{secs(t.ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  /* ---- Finished: one line, expandable ---- */
  const total = totalMs ?? trace.reduce((n, t) => n + t.ms, 0);
  return (
    <div className="thinking-done">
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={open ? "thinking-caret thinking-caret-open" : "thinking-caret"}>
          &rsaquo;
        </span>
        Thought for {secs(total)}
      </button>

      {open && (
        <ul className="thinking-steps thinking-steps-collapsed">
          {trace.map((t, i) => (
            <li className="thinking-step" key={`${t.id}-${i}`}>
              <span className="thinking-step-label">{t.label}</span>
              {t.detail && (
                <span className="thinking-step-detail">{t.detail}</span>
              )}
              <span className="thinking-step-ms">{secs(t.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RetryCountdown({
  retryAfterMs,
  onRetry,
  disabled,
}: {
  retryAfterMs?: number | null;
  onRetry: () => void;
  disabled: boolean;
}) {
  const [remaining, setRemaining] = useState(
    retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 0
  );

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={disabled || remaining > 0}
      className="mt-3 text-xs font-medium px-3 py-1.5 rounded-md border border-current/30 hover:bg-current/10 disabled:opacity-50 transition-colors"
    >
      {remaining > 0 ? `Retry in ${remaining}s` : "Retry this question"}
    </button>
  );
}

/**
 * The readings offered with a clarifying question.
 *
 * These are a shortcut, not a gate: the input box stays live, so a user whose
 * intent is none of the offered readings just types it. That matters because
 * the alternative — a question with no options — makes the person retype the
 * whole thing, which is most of why being asked to clarify feels like an
 * obstacle rather than help.
 */
function ClarifyingOptions({
  options,
  onPick,
  disabled,
}: {
  options: string[];
  onPick: (option: string) => void;
  disabled: boolean;
}) {
  if (!options.length) return null;

  return (
    <div className="clarify">
      <ul className="clarify-list">
        {options.map((option) => (
          <li key={option}>
            <button
              type="button"
              className="clarify-btn"
              onClick={() => onPick(option)}
              disabled={disabled}
            >
              {option}
            </button>
          </li>
        ))}
      </ul>
      <p className="clarify-note">or describe what you need in your own words</p>
    </div>
  );
}

/**
 * Download buttons for the result behind one answer.
 *
 * The href points at a server route that RE-RUNS the query rather than
 * serialising the rows in this component's memory. The browser only ever holds
 * a 200-row sample, and a spreadsheet that silently stops at row 200 while
 * looking complete is precisely the kind of quiet wrongness this app is built
 * to avoid.
 */
function ExportBar({
  messageId,
  rowCount,
}: {
  messageId: string;
  rowCount: number;
}) {
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: "xlsx" | "csv") => {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch(
        `/api/chat/export?messageId=${encodeURIComponent(messageId)}&format=${format}`
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || "The export could not be built.");
        return;
      }

      // The filename is decided by the server, in the Content-Disposition
      // header, so the chat and the file agree on what the data is.
      const disposition = res.headers.get("content-disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] || `davis-export.${format}`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't reach the server to build that file.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="export-bar">
      <button
        type="button"
        className="export-btn"
        onClick={() => download("xlsx")}
        disabled={busy !== null}
      >
        {busy === "xlsx" ? "Building…" : "Excel"}
      </button>
      <button
        type="button"
        className="export-btn"
        onClick={() => download("csv")}
        disabled={busy !== null}
      >
        {busy === "csv" ? "Building…" : "CSV"}
      </button>
      <span className="export-note">
        {rowCount > 0
          ? "Re-runs the query, so the file holds the full result"
          : "Re-runs the query behind this answer"}
      </span>
      {error && <span className="export-error">{error}</span>}
    </div>
  );
}

export default function DataChatPage() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [selectedDb, setSelectedDb] = useState<string>("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string>("");
  /** Stages for the request currently in flight. */
  const [liveTrace, setLiveTrace] = useState<TraceEntry[]>([]);
  /** Bumped after each answer so the conversation list picks up new titles. */
  const [sessionsToken, setSessionsToken] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch connections on load
  useEffect(() => {
    fetch("/api/connections")
      .then(res => res.json())
      .then(data => {
        if (data.connections) {
          setConnections(data.connections);
          if (data.connections.length > 0) {
            setSelectedDb(data.connections[0].id);
          }
        }
      });
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    async (question: string, opts: { echoUser?: boolean } = {}) => {
      if (!question.trim() || !selectedDb || isLoading) return;

      if (opts.echoUser !== false) {
        setMessages(prev => [
          ...prev,
          { id: `u-${Date.now()}`, role: "USER", content: question },
        ]);
      }

      setLastQuestion(question);
      setIsLoading(true);

      setLiveTrace([]);
      const requestStartedAt = Date.now();
      // Collected from the stream so the finished message can keep the trace.
      const collected: TraceEntry[] = [];

      /** Turn a final payload into a chat message. Shared by ok and error. */
      const settle = (status: number, data: any) => {
        const elapsed = Date.now() - requestStartedAt;
        const trace: TraceEntry[] =
          (Array.isArray(data?.trace) && data.trace.length
            ? data.trace
            : collected.filter((t) => !t.running)) || [];

        if (status < 400) {
          if (!sessionId && data.sessionId) setSessionId(data.sessionId);
          setMessages(prev => [
            ...prev,
            {
              id: data.messageId || `a-${Date.now()}`,
              role: "ASSISTANT",
              content: data.message,
              metadata: {
                status: data.status,
                sql: data.sql,
                assumptions: data.assumptions,
                rowCount: data.rowCount,
              },
              chart: data.chart || null,
              clarifyingOptions: Array.isArray(data.clarifyingOptions)
                ? data.clarifyingOptions
                : [],
              knowledgeSources: Array.isArray(data.knowledgeSources)
                ? data.knowledgeSources
                : [],
              abstained: Boolean(data.abstained),
              rows: Array.isArray(data.rows) ? data.rows : [],
              rowCount: typeof data.rowCount === "number" ? data.rowCount : 0,
              degraded: Boolean(data.degraded),
              proseUnavailable: Boolean(data.proseUnavailable),
              answerTruncated: Boolean(data.answerTruncated),
              proseSkippedForQuota: Boolean(data.proseSkippedForQuota),
              noticeKind: data.code === "QUERY_FAILED" ? "failed" : undefined,
              trace,
              thinkingMs: elapsed,
            },
          ]);
          return;
        }

        const kind: NoticeKind =
          data?.code === "PROVIDER_OVERLOADED"
            ? "overloaded"
            : data?.code === "QUOTA_EXCEEDED"
            ? "quota"
            : data?.code === "MODEL_CONFIGURATION"
            ? "config"
            : data?.code === "LOCAL_TIMEOUT"
            ? "timeout"
            : "failed";

        setMessages(prev => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "SYSTEM",
            content: data?.error || "Something went wrong.",
            noticeKind: kind,
            retryAfterMs: data?.retryAfterMs ?? null,
            quotaExplanation: data?.quotaExplanation,
            freeTier: Boolean(data?.freeTier),
            trace,
            thinkingMs: elapsed,
          },
        ]);
      };

      const apply = (evt: any) => {
        if (evt.t === "stage") {
          collected.push({ id: evt.id, label: evt.label, ms: 0, running: true });
          setLiveTrace([...collected]);
        } else if (evt.t === "stage_end") {
          // validate/repair can repeat, so close the most recent open entry
          // with this id rather than the first.
          for (let i = collected.length - 1; i >= 0; i--) {
            if (collected[i].id === evt.id && collected[i].running) {
              collected[i] = {
                ...collected[i],
                detail: evt.detail,
                ms: evt.ms,
                running: false,
              };
              break;
            }
          }
          setLiveTrace([...collected]);
        } else if (evt.t === "done" || evt.t === "error") {
          settle(evt.status, evt.body);
        }
      };

      try {
        const res = await fetch("/api/chat/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            connectionId: selectedDb,
            sessionId,
            stream: true,
          }),
        });

        // A non-streaming response can still arrive (auth redirect, bad JSON
        // body, a proxy that strips streaming) — handle it rather than hanging.
        const contentType = res.headers.get("content-type") || "";
        if (!res.body || !contentType.includes("ndjson")) {
          const data = await res.json().catch(() => ({
            error: "The server returned an unreadable response.",
          }));
          settle(res.status, data);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // NDJSON: complete lines only; the tail may be a partial event.
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              apply(JSON.parse(line));
            } catch {
              /* ignore a malformed line rather than dropping the stream */
            }
          }
        }

        const tail = buffer.trim();
        if (tail) {
          try {
            apply(JSON.parse(tail));
          } catch {
            /* nothing usable in the tail */
          }
        }
      } catch (err) {
        setMessages(prev => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "SYSTEM",
            content:
              "Couldn't reach the server. Check your connection and try again.",
            noticeKind: "network",
          },
        ]);
      } finally {
        setIsLoading(false);
        setLiveTrace([]);
        setSessionsToken((n) => n + 1);
      }
    },
    [selectedDb, isLoading, sessionId]
  );

  /**
   * Reopen a past conversation.
   *
   * The stored metadata is replayed, not just the text: an answer without its
   * chart, citations and trace reads as a bare assertion, which is the opposite
   * of what this application is for.
   */
  const openSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/sessions/${id}`);
      if (!res.ok) return;
      const data = await res.json();

      setSessionId(id);
      setMessages(
        (data.messages || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          metadata: m.metadata,
          chart: m.metadata?.chart || null,
          knowledgeSources: m.metadata?.knowledgeSources || [],
          rows: [],
          rowCount: m.metadata?.rowCount ?? 0,
          trace: m.metadata?.trace || [],
          thinkingMs: m.metadata?.latencyMs,
          degraded: Boolean(m.metadata?.sqlModelDegraded),
        }))
      );
    } catch {
      /* leave the current conversation alone if it cannot be loaded */
    }
  }, []);

  const startNewSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setLastQuestion("");
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input;
    setInput("");
    await send(q);
  };

  const retry = useCallback(() => {
    // Drop the notice, then re-ask without duplicating the user's bubble.
    setMessages(prev => {
      const next = [...prev];
      while (next.length && next[next.length - 1].role === "SYSTEM") next.pop();
      return next;
    });
    void send(lastQuestion, { echoUser: false });
  }, [lastQuestion, send]);

  return (
    <div className="chat-shell">
      <SessionList
        activeId={sessionId}
        onOpen={(id) => void openSession(id)}
        onNew={startNewSession}
        reloadToken={sessionsToken}
      />

    <div className="flex flex-col h-[calc(100vh-4rem)] bg-bg-main relative chat-main">

      {/* Header / Config Bar */}
      <div className="flex items-center justify-between pb-4 border-b border-border-subtle shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Say hi to DAVIS</h1>
          <p className="text-sm text-text-secondary">Get answers powered by your data.</p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-text-muted">Target DB:</label>
          <select
            className="input max-w-[200px] py-2 text-sm bg-bg-elevated border-border-subtle"
            value={selectedDb}
            onChange={e => setSelectedDb(e.target.value)}
            disabled={isLoading || connections.length === 0}
          >
            {connections.length === 0 ? (
              <option value="">No connections found</option>
            ) : (
              connections.map(db => (
                <option key={db.id} value={db.id}>{db.name} ({db.type})</option>
              ))
            )}
          </select>
        </div>
      </div>

      {/* Chat Messages Area */}
      <div className="flex-1 overflow-y-auto py-6 chat-stream scrollbar-hide">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <div className="w-16 h-16 rounded-full bg-brand-primary/10 flex items-center justify-center text-brand-light mb-4 shadow-glow">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2">How can I help you analyze your data?</h2>
          </div>
        ) : (
          messages.map(msg => {
            /* --- Notices get their own treatment, not a chat bubble --- */
            if (msg.role === "SYSTEM" && msg.noticeKind) {
              const style = NOTICE_STYLES[msg.noticeKind];
              const retryable =
                msg.noticeKind === "overloaded" ||
                msg.noticeKind === "network" ||
                msg.noticeKind === "timeout";

              return (
                <div key={msg.id} className="flex justify-start">
                  <div
                    className={`max-w-[80%] rounded-2xl border p-4 ${style.border}`}
                    style={{ borderRadius: "var(--radius-lg)" }}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                      {style.label}
                    </p>
                    <p className="text-sm mt-1 opacity-95">{msg.content}</p>

                    {msg.noticeKind === "config" && (
                      <p className="text-xs mt-2 opacity-75">
                        Retrying won&apos;t help — a configured model ID is wrong,
                        retired, or not granted to this API key. Check the server
                        logs, or open <code>/api/ai/models</code> to see which
                        models the key can actually reach.
                      </p>
                    )}

                    {msg.noticeKind === "quota" && (
                      <div className="text-xs mt-2 opacity-75 space-y-1">
                        {msg.quotaExplanation && <p>{msg.quotaExplanation}</p>}
                        <p>
                          {msg.freeTier
                            ? "The free tier allows only a handful of requests per minute. Enabling billing on the Google Cloud project moves this key to Tier 1, which has far higher limits and no minimum spend."
                            : "This is a limit on this deployment's Gemini key, not on your question. It resets on its own."}
                        </p>
                      </div>
                    )}

                    {msg.trace && msg.trace.length > 0 && (
                      <ThinkingTrace
                        trace={msg.trace}
                        live={false}
                        totalMs={msg.thinkingMs}
                      />
                    )}

                    {retryable && lastQuestion && (
                      <RetryCountdown
                        retryAfterMs={msg.retryAfterMs}
                        onRetry={retry}
                        disabled={isLoading}
                      />
                    )}
                  </div>
                </div>
              );
            }

            const isUser = msg.role === "USER";

            return (
              <div key={msg.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                {/* Assistant bubbles run wider than user bubbles: a result table
                    needs the room, and squeezing one into 80% forces every cell
                    to wrap. */}
                <div
                  className={`chat-bubble ${
                    isUser ? "chat-bubble-user max-w-[80%]" : "chat-bubble-assistant max-w-[92%]"
                  }`}
                >
                  <div className="text-sm">
                    {msg.role === "ASSISTANT" && msg.trace && msg.trace.length > 0 && (
                      <ThinkingTrace
                        trace={msg.trace}
                        live={false}
                        totalMs={msg.thinkingMs}
                      />
                    )}
                    {msg.role === "ASSISTANT" ? (
                      <div className="markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    )}
                  </div>

                  {msg.role === "ASSISTANT" &&
                    (msg.knowledgeSources?.length ?? 0) > 0 && (
                      <KnowledgeSources sources={msg.knowledgeSources || []} />
                    )}

                  {msg.role === "ASSISTANT" &&
                    (msg.clarifyingOptions?.length ?? 0) > 0 && (
                      <ClarifyingOptions
                        options={msg.clarifyingOptions || []}
                        onPick={(option) => void send(option)}
                        disabled={isLoading}
                      />
                    )}

                  {/* The chart sits below the prose, never above it: the
                      sentence is the answer and the chart is the shape of it.
                      Every figure the chart shows is also in the text and in
                      the export, so nothing depends on hovering a mark. */}
                  {msg.role === "ASSISTANT" && msg.chart && (
                    <ResultChart chart={msg.chart} />
                  )}

                  {msg.role === "ASSISTANT" &&
                    msg.metadata?.sql &&
                    (msg.rowCount ?? 0) > 0 && (
                      <ExportBar
                        messageId={msg.id}
                        rowCount={msg.rowCount ?? 0}
                      />
                    )}

                  {/* Quiet footer when the answer came from a fallback path,
                      so a degraded answer is never mistaken for a normal one. */}
                  {msg.role === "ASSISTANT" &&
                    (msg.degraded ||
                      msg.proseUnavailable ||
                      msg.answerTruncated ||
                      msg.proseSkippedForQuota) && (
                      <p className="text-[11px] mt-3 text-text-muted italic">
                        {msg.proseSkippedForQuota
                          ? "Written summary skipped to conserve API quota — figures are verified."
                          : msg.answerTruncated
                          ? "Full result shown directly — the written summary ran long."
                          : msg.proseUnavailable
                          ? "Figures verified from your database; written summary unavailable."
                          : "Answered with a fallback model while the primary one was busy."}
                      </p>
                    )}
                </div>
              </div>
            );
          })
        )}

        {/* Live progress. Replaces the bare spinner: at 20-30s per question a
            dot animation gives no sense that anything is happening. */}
        {isLoading && <ThinkingTrace trace={liveTrace} live />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="mt-4 shrink-0 relative">
        <div className="absolute inset-x-0 bottom-0 top-[-20px] bg-gradient-to-t from-bg-main to-transparent pointer-events-none" />
        <div className="relative z-10 flex items-center gap-3 bg-bg-surface border border-border-subtle rounded-xl p-2 shadow-lg shadow-black/20 focus-within:border-brand-primary/50 transition-colors">
          <input
            type="text"
            className="flex-round bg-transparent border-none outline-none px-4 py-3 text-sm placeholder:text-text-muted"
            style={{ borderRadius: "var(--radius-lg)", height: "2.5rem" }}
            placeholder="Ask DAVIS"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading || !selectedDb}
          />
          <button
            type="submit"
            className="w-10 h-10 rounded-lg bg-brand-primary text-white flex items-center justify-center hover:bg-brand-primary/90 disabled:opacity-50 transition-all shrink-0 shadow-sm"
            disabled={isLoading || !input.trim() || !selectedDb}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        {!selectedDb && connections.length > 0 && (
          <p className="absolute -top-6 left-2 text-xs text-warning">Please select a database connection first.</p>
        )}
      </form>
    </div>
    </div>
  );
}
