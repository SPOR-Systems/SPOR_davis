"use client";

import { useAuth } from "@/lib/auth/context";
import Link from "next/link";

export default function DashboardOverview() {
  const { user, organization } = useAuth();

  return (
    <div className="animate-fade-in">
      <header className="mb-10">
        <h1 className="text-3xl font-bold mb-2">
          Welcome back, {user?.name.split(" ")[0]}
        </h1>
        <p className="text-text-secondary">
          Here&apos;s what&apos;s happening in your {organization?.name} intelligence workspace today.
        </p>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10" style={{ padding: "1rem 0 1rem 0" }}>
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-sm" style={{ background: "#363737" }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider">Active Connections</h3>
            <span className="w-8 h-8 rounded-full bg-brand-primary/10 text-brand-light flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5V19A9 3 0 0 0 21 19V5" />
                <path d="M3 12A9 3 0 0 0 21 12" />
              </svg>
            </span>
          </div>
          <div className="text-3xl font-bold">0</div>
          <p className="text-sm text-text-muted mt-2">Databases ready to query</p>
        </div>

        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-sm" style={{ background: "#363737" }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider">Indexed Documents</h3>
            <span className="w-8 h-8 rounded-full bg-teal-primary/10 text-teal-light flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                <path d="M8 7h6" />
                <path d="M8 11h8" />
              </svg>
            </span>
          </div>
          <div className="text-3xl font-bold">0</div>
          <p className="text-sm text-text-muted mt-2">In your knowledge base</p>
        </div>

        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-sm" style={{ background: "#363737" }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-text-muted uppercase tracking-wider">Recent Queries</h3>
            <span className="w-8 h-8 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
          </div>
          <div className="text-3xl font-bold">0</div>
          <p className="text-sm text-text-muted mt-2">Generated this week</p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mb-10">
        <h2 className="text-xl font-bold mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          <Link href="/connections" className="group p-6 bg-bg-elevated border border-border-subtle rounded-xl hover:border-brand-primary/50 transition-colors flex items-start gap-4">
            <div className="w-12 h-12 rounded-lg bg-brand-primary/10 text-brand-light flex items-center justify-center group-hover:bg-brand-primary group-hover:text-white transition-colors">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-lg mb-1 group-hover:text-brand-light transition-colors">Connect Database</h3>
              <p className="text-sm text-text-secondary">Add a new PostgreSQL, MySQL, or SQL Server database to start querying.</p>
            </div>
          </Link>

          <Link href="/knowledge" className="group p-6 bg-bg-elevated border border-border-subtle rounded-xl hover:border-teal-primary/50 transition-colors flex items-start gap-4">
            <div className="w-12 h-12 rounded-lg bg-teal-primary/10 text-teal-light flex items-center justify-center group-hover:bg-teal-primary group-hover:text-white transition-colors">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-lg mb-1 group-hover:text-teal-light transition-colors">Upload Documents</h3>
              <p className="text-sm text-text-secondary">Ingest PDFs, spreadsheets, or company policies into your knowledge base.</p>
            </div>
          </Link>

        </div>
      </div>
    </div>
  );
}
