"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

// ── SVG Icons ──
const DatabaseIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </svg>
);

const BrainIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a4 4 0 0 0-4 4c0 1.1.45 2.1 1.17 2.83L12 12" />
    <path d="M12 2a4 4 0 0 1 4 4c0 1.1-.45 2.1-1.17 2.83L12 12" />
    <path d="M12 12l-2.83 2.83A4 4 0 1 0 12 22" />
    <path d="M12 12l2.83 2.83A4 4 0 1 1 12 22" />
  </svg>
);

const ChartIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 16l4-8 4 4 4-6" />
  </svg>
);

const BookIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    <path d="M8 7h6" />
    <path d="M8 11h8" />
  </svg>
);

const ShieldIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

const SparkleIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="M12 5l7 7-7 7" />
  </svg>
);

// ── Feature Data ──
const features = [
  {
    icon: <DatabaseIcon />,
    iconClass: "landing-feature-icon-blue",
    title: "Universal Database Access",
    description:
      "Connect to PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, SQLite, and MariaDB. Query any database through natural language.",
  },
  {
    icon: <ChartIcon />,
    iconClass: "landing-feature-icon-teal",
    title: "Intelligent Visualization",
    description:
      "Automatically generate charts, graphs, and dashboards from your queries. DAVIS picks the best visualization for your data.",
  },
  {
    icon: <BrainIcon />,
    iconClass: "landing-feature-icon-purple",
    title: "AI-Powered Analysis",
    description:
      "Powered by Google Gemini, DAVIS translates natural language into SQL, detects patterns, and surfaces actionable insights.",
  },
  {
    icon: <BookIcon />,
    iconClass: "landing-feature-icon-blue",
    title: "Knowledge Base Q&A",
    description:
      "Ingest PDFs, Word docs, Excel files, and web pages. Ask questions about company processes and get precise, sourced answers.",
  },
  {
    icon: <ShieldIcon />,
    iconClass: "landing-feature-icon-teal",
    title: "Enterprise Security",
    description:
      "Multi-tenant data isolation, encrypted credentials, read-only query enforcement, and comprehensive audit logging.",
  },
  {
    icon: <SparkleIcon />,
    iconClass: "landing-feature-icon-purple",
    title: "Pattern Recognition",
    description:
      "Automatically identify trends, anomalies, and correlations across your enterprise data without writing a single query.",
  },
];

// ── Database Logos ──
const databases = [
  { name: "PostgreSQL", color: "#336791", abbr: "PG" },
  { name: "MySQL", color: "#4479A1", abbr: "My" },
  { name: "SQL Server", color: "#CC2927", abbr: "MS" },
  { name: "Oracle", color: "#F80000", abbr: "Or" },
  { name: "MongoDB", color: "#47A248", abbr: "Mg" },
  { name: "SQLite", color: "#003B57", abbr: "SL" },
  { name: "MariaDB", color: "#003545", abbr: "Ma" },
];

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className={styles["landing-page"]}>
      {/* ── Ambient Background ── */}
      <div className={styles["landing-bg"]}>
        <div className={`${styles["landing-bg-orb"]} ${styles["landing-bg-orb-1"]}`} />
        <div className={`${styles["landing-bg-orb"]} ${styles["landing-bg-orb-2"]}`} />
        <div className={`${styles["landing-bg-orb"]} ${styles["landing-bg-orb-3"]}`} />
        <div className={styles["landing-grid"]} />
      </div>

      {/* ── Navigation ── */}
      <nav
        className={`${styles["landing-nav"]} ${
          scrolled ? styles["landing-nav-scrolled"] : ""
        }`}
      >
        <div className={styles["landing-nav-logo"]}>
          <div className={styles["landing-nav-logo-icon"]}>D</div>
          <div>
            <div className={styles["landing-nav-title"]}>DAVIS</div>
            <div className={styles["landing-nav-subtitle"]}>by SPOR Systems</div>
          </div>
        </div>
        <div className={styles["landing-nav-actions"]}>
          <a href="/login" className="btn btn-ghost">
            Sign In
          </a>
          <a href="/register" className="btn btn-primary">
            Get Started
          </a>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className={styles["landing-hero"]}>
        <div className={styles["landing-hero-badge"]}>
          <span className={styles["landing-hero-badge-dot"]} />
          AI-Powered Enterprise Intelligence
        </div>

        <h1>
          Ask Your Data
          <br />
          <span className={styles["landing-hero-gradient-text"]}>
            Anything.
          </span>
        </h1>

        <p className={styles["landing-hero-description"]}>
          Connect your enterprise databases and knowledge bases. Ask questions in
          plain English. Get instant analysis, visualizations, and actionable
          insights — no SQL required.
        </p>

        <div className={styles["landing-hero-actions"]}>
          <a href="/register" className={styles["landing-hero-btn-primary"]}>
            Start Free <ArrowRightIcon />
          </a>
          <a href="#features" className={styles["landing-hero-btn-secondary"]}>
            See How It Works
          </a>
        </div>

        <div className={styles["landing-scroll-indicator"]}>
          <span>Scroll</span>
          <div className={styles["landing-scroll-indicator-line"]} />
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className={styles["landing-features"]}>
        <div className={styles["landing-features-header"]}>
          <h2>
            Enterprise Intelligence,{" "}
            <span className={styles["landing-hero-gradient-text"]}>
              Simplified
            </span>
          </h2>
          <p>
            DAVIS transforms how your team interacts with corporate data and
            institutional knowledge.
          </p>
        </div>

        <div className={styles["landing-features-grid"]}>
          {features.map((feature, idx) => (
            <div key={idx} className={styles["landing-feature-card"]}>
              <div
                className={`${styles["landing-feature-icon"]} ${
                  styles[feature.iconClass]
                }`}
              >
                {feature.icon}
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Supported Databases ── */}
      <section className={styles["landing-databases"]}>
        <h2>Connect to Any Database</h2>
        <p>
          First-class support for all major enterprise database systems.
        </p>
        <div className={styles["landing-db-logos"]}>
          {databases.map((db) => (
            <div key={db.name} className={styles["landing-db-logo"]}>
              <div
                className={styles["landing-db-logo-icon"]}
                style={{ background: db.color, color: "white" }}
              >
                {db.abbr}
              </div>
              <span>{db.name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className={styles["landing-cta"]}>
        <div className={styles["landing-cta-card"]}>
          <h2>Ready to unlock your data?</h2>
          <p>
            Set up DAVIS in minutes. Connect your first database and start
            asking questions immediately.
          </p>
          <a href="/register" className="btn btn-primary btn-lg">
            Get Started Free <ArrowRightIcon />
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className={styles["landing-footer"]}>
        <p>
          © {new Date().getFullYear()}{" "}
          <a
            href="https://sporsystems.ca"
            target="_blank"
            rel="noopener noreferrer"
          >
            SPOR Systems Inc.
          </a>{" "}
          All rights reserved.
        </p>
      </footer>
    </div>
  );
}
