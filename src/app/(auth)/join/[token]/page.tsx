"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/context";
import Link from "next/link";

/**
 * Accepting an invitation. All the person does is choose a password — the role
 * and tenant access were set by whoever invited them.
 */
export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const router = useRouter();
  const { login } = useAuth();

  const [invite, setInvite] = useState<{ name: string; email: string; organization: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/invites/${token}`);
        const data = await res.json();
        if (res.ok) setInvite(data);
        else setError(data.error || "This invitation is no longer valid.");
      } catch {
        setError("This invitation could not be checked. Try again in a moment.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/invites/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not finish setting up your account.");
        return;
      }
      login("", data.user, data.organization);
      router.push("/dashboard");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-card">
        <p className="text-secondary text-sm text-center">Checking your invitation…</p>
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="auth-card">
        <h1 className="text-2xl font-bold mb-2">Invitation not valid</h1>
        <p className="text-secondary text-sm">{error}</p>
        <div style={{ marginTop: "var(--space-4)" }}>
          <Link href="/login" className="btn btn-secondary btn-sm">Go to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-card animate-fade-in-up">
      <div className="flex flex-col items-center mb-6">
        <h1 className="text-2xl font-bold mb-2">Welcome, {invite.name}</h1>
        <p className="text-secondary text-sm text-center">
          You&apos;ve been invited to {invite.organization}. Choose a password to
          finish setting up your account.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <div className="p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md">
            {error}
          </div>
        )}

        <div>
          <label className="label">Email</label>
          <input className="input" value={invite.email} disabled readOnly />
        </div>

        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="input"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type="password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Setting up…" : "Create my account"}
        </button>
      </form>
    </div>
  );
}
