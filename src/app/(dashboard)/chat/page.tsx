"use client";

import { useState, useEffect, useRef } from "react";
import { DatabaseConnection } from "@/components/connections/AddConnectionModal";

import ReactMarkdown from 'react-markdown';

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata?: any;
}

export default function DataChatPage() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [selectedDb, setSelectedDb] = useState<string>("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !selectedDb || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "USER",
      content: input
    };

    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: userMsg.content,
          connectionId: selectedDb,
          sessionId
        }),
      });

      const data = await res.json();

      if (res.ok) {
        if (!sessionId) setSessionId(data.sessionId);

        const assistantMsg: Message = {
          id: data.messageId,
          role: "ASSISTANT",
          content: data.message,
          metadata: { status: "success" }
        };
        setMessages(prev => [...prev, assistantMsg]);
      } else {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: "SYSTEM",
          content: `Error: ${data.error}`
        }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: "SYSTEM",
        content: "Network error occurred."
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-bg-main relative">

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
      <div className="flex-1 overflow-y-auto py-6 space-y-6 scrollbar-hide">
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
          messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === "USER" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl p-5 ${msg.role === "USER"
                ? "bg-brand-primary text-white shadow-md rounded-tr-sm"
                : msg.role === "SYSTEM"
                  ? "bg-danger/10 border border-danger/20 text-danger"
                  : "bg-bg-surface border border-border-subtle shadow-sm rounded-tl-sm"
                }`} style={{ borderRadius: "var(--radius-lg)", backgroundColor: "#363737", padding: "0.5rem" }}>
                {/* Regular content */}
                <div className="text-sm">
                  {msg.role === "ASSISTANT" ? (
                    <div className="markdown-content prose-sm max-w-none text-inherit [&>ul]:list-disc [&>ul]:ml-4 [&>ul]:my-2 [&>p]:mb-2 last:[&>p]:mb-0 [&>strong]:font-bold">
                      <ReactMarkdown>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

        {/* Loading Indicator for User Input */}
        {isLoading && !messages.find(m => m.metadata?.status === "executing") && (
          <div className="flex justify-start">
            <div className="bg-bg-surface border border-border-subtle shadow-sm rounded-2xl rounded-tl-sm p-5 w-24 flex items-center justify-center">
              <div className="typing-indicator scale-125 m-0">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}

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
  );
}
