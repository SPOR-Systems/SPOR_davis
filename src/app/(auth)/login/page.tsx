"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/context";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  /**
   * The same email can belong to more than one organization. When the password
   * matches in several, the server refuses to guess and hands back the list.
   */
  const [choices, setChoices] = useState<{ name: string; slug: string }[] | null>(null);
  const router = useRouter();
  const { login, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      router.push("/dashboard");
    }
  }, [isAuthenticated, router]);

  const submit = async (organizationSlug?: string) => {
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, organizationSlug }),
      });

      const data = await res.json();

      if (data?.chooseOrganization) {
        setChoices(data.organizations || []);
        return;
      }

      if (res.ok) {
        login(data.token, data.user, data.organization);
        router.push("/dashboard");
      } else {
        setError(data.error || "Failed to log in");
      }
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChoices(null);
    await submit();
  };

  if (choices) {
    return (
      <div className="auth-card animate-fade-in-up">
        <div className="flex flex-col items-center mb-6">
          <h1 className="text-2xl font-bold mb-2">Which workspace?</h1>
          <p className="text-secondary text-sm text-center">
            This email is used by more than one organization.
          </p>
        </div>

        {error && (
          <div className="p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md" style={{ marginBottom: "var(--space-4)" }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {choices.map((c) => (
            <button
              key={c.slug}
              type="button"
              className="btn btn-secondary"
              disabled={loading}
              onClick={() => submit(c.slug)}
            >
              {c.name}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: "var(--space-4)" }}
          onClick={() => { setChoices(null); setError(""); }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="auth-card animate-fade-in-up">
      <div className="flex flex-col items-center mb-8">
        <div className="w-12 h-12 bg-gradient-to-br from-brand-primary to-teal-primary rounded-xl flex items-center justify-center font-black text-2xl text-white shadow-glow mb-4">
          D
        </div>
        <h1 className="text-2xl font-bold mb-2">Welcome Back</h1>
        <p className="text-secondary text-sm text-center">
          Sign in to your DAVIS intelligence workspace.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <div className="p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md animate-fade-in">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">Work Email</label>
          <input
            id="email"
            type="email"
            className="input"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>

        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="input"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>

        <button 
          type="submit" 
          className="btn btn-primary w-full mt-2"
          disabled={loading}
        >
          {loading ? (
            <div className="typing-indicator">
              <span /><span /><span />
            </div>
          ) : (
            "Sign In"
          )}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-secondary">
        Don't have an organization account?{" "}
        <Link href="/register" className="text-brand font-medium hover:text-brand-primary">
          Register here
        </Link>
      </div>
    </div>
  );
}
