"use client";

import { useAuth } from "@/lib/auth/context";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { prefetchDashboard } from "@/lib/clientCache";
import Link from "next/link";
import Image from "next/image";

const DashboardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="9" />
    <rect x="14" y="3" width="7" height="5" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </svg>
);

const DatabaseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </svg>
);

const ChatIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const DocumentIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    <path d="M8 7h6" />
    <path d="M8 11h8" />
  </svg>
);

const BuildingIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" /><path d="M16 6h.01" />
    <path d="M8 10h.01" /><path d="M16 10h.01" />
    <path d="M8 14h.01" /><path d="M16 14h.01" />
  </svg>
);

const GaugeIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20a8 8 0 1 1 8-8" />
    <path d="m12 12 4-4" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const LogOutIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

/**
 * `adminOnly` items are hidden from ordinary members — and the endpoints behind
 * them refuse a member too, so this is tidiness rather than the protection.
 *
 * A member's job here is to ask questions about their own tenant. Database
 * hosts, API keys, billing and other people's access are not their business,
 * and a page they can see but never use is just a locked door in the hallway.
 */
const navItems = [
  { name: "Overview", href: "/dashboard", icon: <DashboardIcon /> },
  { name: "Data Chat", href: "/chat", icon: <ChatIcon /> },
  { name: "Knowledge Base", href: "/knowledge", icon: <DocumentIcon /> },
  { name: "Connections", href: "/connections", icon: <DatabaseIcon />, adminOnly: true },
  { name: "Tenants", href: "/tenants", icon: <BuildingIcon />, adminOnly: true },
  { name: "Usage", href: "/usage", icon: <GaugeIcon />, adminOnly: true },
  { name: "Settings", href: "/settings", icon: <SettingsIcon />, adminOnly: true },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, organization, isLoading, isAuthenticated, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // Once signed in and the current page has settled, quietly fetch what the
  // other tabs will need. The knowledge base in particular used to make people
  // wait through three requests every time they opened it, for data that had
  // usually not changed since the last time they looked.
  useEffect(() => {
    if (isAuthenticated) prefetchDashboard(user?.role === "ADMIN");
  }, [isAuthenticated]);

  /**
   * A member who types /tenants into the address bar goes back to the chat.
   *
   * The endpoints already refuse them, so without this they would land on a
   * page that renders empty tables and unexplained errors — which reads as the
   * app being broken rather than as a door that was never theirs.
   */
  useEffect(() => {
    if (isLoading || !isAuthenticated || user?.role === "ADMIN") return;
    const adminPaths = navItems.filter((i) => i.adminOnly).map((i) => i.href);
    if (adminPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      router.replace("/chat");
    }
  }, [isLoading, isAuthenticated, user?.role, pathname, router]);

  /**
   * Someone waiting to join shows on the Settings item itself.
   *
   * The count inside Settings only helps a person already looking at Settings,
   * and nobody opens that page speculatively — so a request could sit unseen
   * for days. Re-checked on navigation and every couple of minutes, which is as
   * fresh as this needs to be.
   */
  const [pendingJoins, setPendingJoins] = useState(0);
  useEffect(() => {
    if (!isAuthenticated || user?.role !== "ADMIN") return;
    let alive = true;
    const check = () =>
      fetch("/api/registrations")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setPendingJoins(d.pendingCount || 0))
        .catch(() => {});
    check();
    const id = setInterval(check, 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [isAuthenticated, user?.role, pathname]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-main">
        <div className="typing-indicator scale-150">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg-main text-text-primary">
      {/* ── Sidebar ── */}
      <aside className="w-72 flex-shrink-0 bg-bg-surface border-r border-border-subtle flex flex-col z-20">

        {/* Organization Brand */}
        <div className="h-16 flex items-center px-6 border-b border-border-subtle">
          <Image
            src="/logo.png"
            alt="SPOR Systems"
            width={32}
            height={32}
            className="org-logo"
          />
          <span className="font-semibold truncate" title={organization?.name}>
            {organization?.name}
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-6 px-4">
          {navItems
            .filter((item) => !item.adminOnly || user?.role === "ADMIN")
            .map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`nav-item ${isActive ? "nav-item-active" : ""}`}
              >
                <span className="nav-item-icon">
                  {item.icon}
                </span>
                {item.name}
                {item.href === "/settings" && pendingJoins > 0 && (
                  <span className="nav-badge" title={`${pendingJoins} waiting to join`}>
                    {pendingJoins}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* User Footer */}
        <div className="p-4 border-t border-border-subtle bg-bg-main/50">
          <div className="flex items-center p-3 mb-3 bg-bg-elevated border border-border-subtle rounded-lg">
            <div className="user-avatar">
              {user?.name.charAt(0).toUpperCase()}
            </div>
            <div className="overflow-hidden">
              <p className="text-sm font-semibold truncate">{user?.name}</p>
              <p className="text-xs text-text-muted truncate">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-border-subtle bg-bg-elevated text-text-secondary hover:border-danger/30 hover:text-danger hover:bg-danger/10 transition-colors"
          >
            <LogOutIcon /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Gradient backdrop */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[300px] bg-brand-primary/5 blur-[100px] rounded-full pointer-events-none" />

        <div className="flex-1 overflow-y-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
