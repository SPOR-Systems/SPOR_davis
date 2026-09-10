"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/context";
import Link from "next/link";

export default function RegisterPage() {
  const [formData, setFormData] = useState({
    organizationName: "",
    name: "",
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * "create" makes a new organization. "join" asks an existing one to let you
   * in, and creates nothing until someone there approves — so a stranger who
   * guesses an organization's name does not end up inside it.
   */
  const [mode, setMode] = useState<"create" | "join">("create");
  
  const router = useRouter();
  const { login } = useAuth();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (formData.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, mode }),
      });

      const data = await res.json();

      if (res.status === 202 && data.pending) {
        // Joining: there is no account yet and nothing to sign in to.
        setSent(data.message);
      } else if (res.ok) {
        login(data.token, data.user, data.organization);
        router.push("/dashboard");
      } else {
        setError(data.error || "Failed to register");
      }
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
      <div className="flex flex-col items-center mb-6">
        <h1 className="text-2xl font-bold mb-2">
          {mode === "create" ? "Create a workspace" : "Join a workspace"}
        </h1>
        <p className="text-secondary text-sm text-center">
          {mode === "create"
            ? "Set up DAVIS for your organization. You'll be its administrator."
            : "Ask to join an organization that already uses DAVIS."}
        </p>
      </div>

      <div className="adm-tabs" style={{ marginBottom: "var(--space-5)" }}>
        <button
          type="button"
          className={`adm-tab ${mode === "create" ? "adm-tab-active" : ""}`}
          onClick={() => { setMode("create"); setError(""); }}
        >
          New organization
        </button>
        <button
          type="button"
          className={`adm-tab ${mode === "join" ? "adm-tab-active" : ""}`}
          onClick={() => { setMode("join"); setError(""); }}
        >
          Join an existing one
        </button>
      </div>

      {sent && (
        <div className="adm-notice adm-notice-ok">
          {sent}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <div className="p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md animate-fade-in">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="organizationName">
            {mode === "create" ? "Organization name" : "Which organization?"}
          </label>
          <input
            id="organizationName"
            name="organizationName"
            type="text"
            className="input"
            placeholder="Acme Corp"
            value={formData.organizationName}
            onChange={handleChange}
            required
          />
          {mode === "join" && (
            <p className="adm-field-hint">
              Type its name exactly as it was set up. Someone there will need to
              approve you before you can sign in.
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="name">Your Name</label>
          <input
            id="name"
            name="name"
            type="text"
            className="input"
            placeholder="Jane Doe"
            value={formData.name}
            onChange={handleChange}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="email">Work Email</label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            placeholder="jane@acmecorp.com"
            value={formData.email}
            onChange={handleChange}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            placeholder="••••••••"
            value={formData.password}
            onChange={handleChange}
            required
            minLength={8}
          />
          <p className="text-xs text-muted mt-1">Must be at least 8 characters</p>
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
            "Create Account"
          )}
        </button>
      </form>

      <div className="mt-6 text-center text-sm text-secondary">
        Already have an account?{" "}
        <Link href="/login" className="text-brand font-medium hover:text-brand-primary">
          Sign in
        </Link>
      </div>
    </div>
  );
}
