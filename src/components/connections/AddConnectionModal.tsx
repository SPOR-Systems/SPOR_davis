"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface DatabaseConnection {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  status: string;
  createdAt: string;
}

interface AddConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newConnection: DatabaseConnection) => void;
}

const SUPPORTED_DATABASES = [
  { value: "POSTGRESQL", label: "PostgreSQL", port: 5432 },
  { value: "MYSQL", label: "MySQL", port: 3306 },
  { value: "MSSQL", label: "SQL Server", port: 1433 },
  { value: "ORACLE", label: "Oracle", port: 1521 },
  { value: "MONGODB", label: "MongoDB", port: 27017 },
  { value: "MARIADB", label: "MariaDB", port: 3306 },
  { value: "SQLITE", label: "SQLite", port: 0 },
];

export default function AddConnectionModal({ isOpen, onClose, onSuccess }: AddConnectionModalProps) {
  const [formData, setFormData] = useState({
    name: "",
    type: "POSTGRESQL",
    host: "localhost",
    port: "5432",
    database: "",
    username: "",
    password: "",
    ssl: false,
  });

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;

    // Auto-update port when changing DB type
    if (name === "type") {
      const selectedDb = SUPPORTED_DATABASES.find(db => db.value === value);
      setFormData(prev => ({
        ...prev,
        type: value,
        port: selectedDb ? String(selectedDb.port) : prev.port
      }));
      return;
    }

    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (res.ok) {
        onSuccess(data.connection);
        onClose();
        // Reset form
        setFormData({
          name: "",
          type: "POSTGRESQL",
          host: "localhost",
          port: "5432",
          database: "",
          username: "",
          password: "",
          ssl: false,
        });
      } else {
        setError(data.error || "Failed to add connection");
      }
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      style={{ top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <div className="bg-bg-surface border border-border-default rounded-xl w-full max-w-lg shadow-2xl overflow-hidden animate-fade-in-up" style={{ background: "slategray" }}>

        {/* Header */}
        <div className="px-6 py-4 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-xl font-bold">Add Database Connection</h2>
          <button
            onClick={onClose}
            className="p-2 border border-border-subtle rounded-md hover:bg-bg-elevated hover:text-text-primary text-text-muted transition-colors flex items-center justify-center"
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto max-h-[70vh]">
          {error && (
            <div className="mb-4 p-3 bg-danger-bg border border-danger text-danger text-sm rounded-md">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="name">Connection Name</label>
              <input
                id="name"
                name="name"
                type="text"
                className="input"
                placeholder="Production Database"
                value={formData.name}
                onChange={handleChange}
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="type">Database Type</label>
              <select
                id="type"
                name="type"
                className="input"
                value={formData.type}
                onChange={handleChange}
              >
                {SUPPORTED_DATABASES.map(db => (
                  <option key={db.value} value={db.value}>{db.label}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="label" htmlFor="host">Host</label>
                <input
                  id="host"
                  name="host"
                  type="text"
                  className="input"
                  placeholder="db.example.com"
                  value={formData.host}
                  onChange={handleChange}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="port">Port</label>
                <input
                  id="port"
                  name="port"
                  type="number"
                  className="input"
                  value={formData.port}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="database">Database Name</label>
              <input
                id="database"
                name="database"
                type="text"
                className="input"
                placeholder="app_production"
                value={formData.database}
                onChange={handleChange}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label" htmlFor="username">Username</label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  className="input"
                  value={formData.username}
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
                />
              </div>
            </div>

            <div className="pt-2">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="ssl"
                  className="w-4 h-4 rounded bg-bg-elevated border-border-default text-brand-primary focus:ring-brand-primary/50"
                  checked={formData.ssl}
                  onChange={handleChange}
                />
                <span className="text-sm font-medium">Require SSL Connection</span>
              </label>
            </div>
          </div>

          <div className="mt-8 flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? (
                <div className="typing-indicator">
                  <span /><span /><span />
                </div>
              ) : (
                "Save Connection"
              )}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
}
