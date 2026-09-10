import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptText } from "@/lib/encryption";
import type { Dialect } from "@/lib/db/connection";
import {
  ScopeError,
  assertSafeIdentifier,
  assertSafeScopeValue,
  scopedViewName,
  supportsManagedViews,
} from "@/lib/db/scope";

export const dynamic = "force-dynamic";

/**
 * Read and write a connection's row-level scoping configuration.
 *
 * Every write clears `verifiedAt`. Changing which tables are exposed, or which
 * column carries the tenant, invalidates whatever the last isolation check
 * proved — and a connection that is not currently verified does not answer
 * embedded questions. So the effect of editing this is that the integrator must
 * re-run the check, which is the intended effect.
 */

const MODES = ["NONE", "SEPARATE_CREDENTIALS", "NATIVE_RLS", "MANAGED_VIEWS"] as const;
type Mode = (typeof MODES)[number];

async function owned(organizationId: string, id: string) {
  return prisma.databaseConnection.findFirst({ where: { id, organizationId } });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const conn = await owned(user.organizationId, params.id);
  if (!conn) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  let tables: string[] = [];
  try {
    const parsed = JSON.parse(conn.scopedTables || "[]");
    if (Array.isArray(parsed)) tables = parsed.map(String);
  } catch {
    /* ignore */
  }

  const credentials = await prisma.connectionScopeCredential.findMany({
    where: { connectionId: conn.id },
    select: { id: true, scopeKey: true, database: true, username: true },
    orderBy: { scopeKey: "asc" },
  });

  return NextResponse.json({
    scope: {
      mode: conn.scopeMode,
      column: conn.scopeColumn,
      setting: conn.scopeSetting,
      tables,
      verifiedAt: conn.verifiedAt,
      verifyNote: conn.verifyNote,
      /** What a scoped query would be allowed to name. */
      exposedObjects:
        conn.scopeMode === "MANAGED_VIEWS" ? tables.map(scopedViewName) : tables,
      managedViewsSupported: supportsManagedViews(conn.type.toUpperCase() as Dialect),
    },
    scopeCredentials: credentials,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const conn = await owned(user.organizationId, params.id);
  if (!conn) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "BAD_BODY" }, { status: 400 });
  }

  const mode = String(body.mode || "NONE").toUpperCase() as Mode;
  if (!MODES.includes(mode)) {
    return NextResponse.json(
      { error: `mode must be one of ${MODES.join(", ")}.`, code: "BAD_MODE" },
      { status: 400 }
    );
  }

  const dialect = conn.type.toUpperCase() as Dialect;

  if (mode === "NONE") {
    const updated = await prisma.databaseConnection.update({
      where: { id: conn.id },
      data: {
        scopeMode: "NONE",
        scopeColumn: null,
        scopeSetting: null,
        scopedTables: null,
        verifiedAt: null,
        verifyNote: "No separation set up — nothing to test.",
      },
    });
    await prisma.tenantSchemaProfile.deleteMany({ where: { connectionId: conn.id } });
    return NextResponse.json({ scope: { mode: updated.scopeMode } });
  }

  /* ---- Tables ---------------------------------------------------------- */
  const rawTables: unknown = body.tables;
  if (!Array.isArray(rawTables) || rawTables.length === 0) {
    return NextResponse.json(
      {
        error: "List at least one table DAVIS is allowed to read.",
        code: "NO_TABLES",
      },
      { status: 400 }
    );
  }
  let tables: string[];
  try {
    tables = [
      ...new Set(rawTables.map((t) => assertSafeIdentifier(String(t).trim(), "Table"))),
    ];
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof ScopeError ? err.message : "Unusable table name.",
        code: "BAD_TABLE",
      },
      { status: 400 }
    );
  }

  /* ---- Mode-specific requirements -------------------------------------- */
  let column: string | null = null;
  let setting: string | null = null;

  if (mode === "MANAGED_VIEWS") {
    if (!supportsManagedViews(dialect)) {
      return NextResponse.json(
        {
          error:
            `${conn.type} can't filter this way. Use a separate database or login ` +
            `per customer instead.`,
          code: "MODE_UNSUPPORTED",
        },
        { status: 400 }
      );
    }
    if (typeof body.column !== "string" || !body.column.trim()) {
      return NextResponse.json(
        { error: "Choose the column that says which customer a row belongs to.", code: "NO_COLUMN" },
        { status: 400 }
      );
    }
    try {
      column = assertSafeIdentifier(body.column.trim(), "Scope column");
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof ScopeError ? err.message : "Unusable column.", code: "BAD_COLUMN" },
        { status: 400 }
      );
    }
  }

  if (mode === "NATIVE_RLS") {
    if (typeof body.setting !== "string" || !body.setting.trim()) {
      return NextResponse.json(
        {
          error: 'Enter the setting your database security rules read, e.g. "davis.tenant".',
          code: "NO_SETTING",
        },
        { status: 400 }
      );
    }
    try {
      setting = body.setting.trim();
      assertSafeIdentifier(setting!.replace(".", "_"), "Scope setting");
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof ScopeError ? err.message : "Unusable setting.", code: "BAD_SETTING" },
        { status: 400 }
      );
    }
    // The column is optional for RLS — the policy owns the predicate — but
    // supplying it is what lets the isolation check ask the direct question
    // ("through A's connection, how many of B's rows can I see?"). Without it
    // the check can only compare row counts, which proves much less.
    if (typeof body.column === "string" && body.column.trim()) {
      try {
        column = assertSafeIdentifier(body.column.trim(), "Scope column");
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof ScopeError ? err.message : "Unusable column.", code: "BAD_COLUMN" },
          { status: 400 }
        );
      }
    }
  }

  /* ---- Per-tenant credentials ------------------------------------------ */
  if (mode === "SEPARATE_CREDENTIALS" && Array.isArray(body.scopeCredentials)) {
    for (const entry of body.scopeCredentials) {
      const key = typeof entry?.scopeKey === "string" ? entry.scopeKey.trim() : "";
      if (!key) continue;
      try {
        assertSafeScopeValue(key);
      } catch (err) {
        return NextResponse.json(
          {
            error: err instanceof ScopeError ? err.message : "Unusable tenant key.",
            code: "BAD_SCOPE_KEY",
          },
          { status: 400 }
        );
      }
      const data = {
        database: typeof entry.database === "string" ? entry.database : null,
        username: typeof entry.username === "string" ? entry.username : null,
        ...(typeof entry.password === "string" && entry.password
          ? { encryptedPassword: encryptText(entry.password) }
          : {}),
      };
      const existing = await prisma.connectionScopeCredential.findFirst({
        where: { connectionId: conn.id, scopeKey: key },
        select: { id: true },
      });
      if (existing) {
        await prisma.connectionScopeCredential.update({ where: { id: existing.id }, data });
      } else {
        await prisma.connectionScopeCredential.create({
          data: { connectionId: conn.id, scopeKey: key, ...data },
        });
      }
    }
  }

  const updated = await prisma.databaseConnection.update({
    where: { id: conn.id },
    data: {
      scopeMode: mode,
      scopeColumn: column,
      scopeSetting: setting,
      scopedTables: JSON.stringify(tables),
      // Whatever the last check proved, it proved it about a different
      // configuration.
      verifiedAt: null,
      verifyNote: "Settings changed — run the test again.",
    },
  });

  // Cached statistics were measured through the old surface.
  await prisma.tenantSchemaProfile.deleteMany({ where: { connectionId: conn.id } });
  await prisma.databaseConnection.update({
    where: { id: conn.id },
    data: { schemaCache: null },
  });

  return NextResponse.json({
    scope: {
      mode: updated.scopeMode,
      column: updated.scopeColumn,
      setting: updated.scopeSetting,
      tables,
      exposedObjects: mode === "MANAGED_VIEWS" ? tables.map(scopedViewName) : tables,
      verifiedAt: null,
      verifyNote: updated.verifyNote,
    },
    next: "Test data separation before this connection will answer questions.",
  });
}
