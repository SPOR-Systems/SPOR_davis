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
  const [loading, setLoading] = useState(false);
  
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
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (res.ok) {
        login(data.token, data.user, data.organization);
        router.push("/dashboard"); // We'll create this later
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
        <h1 className="text-2xl font-bold mb-2">Create Workspace</h1>
        <p className="text-secondary text-sm text-center">
          Set up a new DAVIS intelligence workspace for your organization.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <div className="p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md animate-fade-in">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="organizationName">Organization Name</label>
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
