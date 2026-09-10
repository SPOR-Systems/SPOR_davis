import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSafeScopeValue, ScopeError } from "@/lib/db/scope";

export const dynamic = "force-dynamic";

/**
 * ============================================================================
 *  TENANTS
 * ============================================================================
 *  A tenant is one of the integrator's own customers: a clinic, a store, a
 *  branch. An organization is the integrator; the tenants are who their
 *  software serves.
 *
 *  This endpoint is built for the real number. An EMR vendor with 800 clinics
 *  is not going to click "add tenant" 800 times, so POST takes a list, is
 *  idempotent on externalKey, and reports per-row outcomes instead of failing
 *  the batch on one bad key.
 * ============================================================================
 */

const MAX_BATCH = 1000;

interface TenantInput {
  externalKey?: unknown;
  label?: unknown;
  connectionId?: unknown;
  status?: unknown;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status");
  const take = Math.min(Number(url.searchParams.get("take") || 100) || 100, 500);
  const skip = Math.max(Number(url.searchParams.get("skip") || 0) || 0, 0);

  const where = {
    organizationId: user.organizationId,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { externalKey: { contains: q } },
            { label: { contains: q } },
          ],
        }
      : {}),
  };

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      orderBy: { externalKey: "asc" },
      take,
      skip,
      select: {
        id: true,
        externalKey: true,
        label: true,
        status: true,
        connectionId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.tenant.count({ where }),
  ]);

  return NextResponse.json({ tenants, total, take, skip });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "BAD_BODY" }, { status: 400 });
  }

  // One tenant or many, same endpoint.
  const input: TenantInput[] = Array.isArray(body)
    ? body
    : Array.isArray(body?.tenants)
    ? body.tenants
    : [body];

  if (input.length === 0) {
    return NextResponse.json({ error: "No tenants supplied.", code: "EMPTY" }, { status: 400 });
  }
  if (input.length > MAX_BATCH) {
    return NextResponse.json(
      {
        error: `At most ${MAX_BATCH} tenants per request; send the rest in a second call.`,
        code: "TOO_MANY",
      },
      { status: 400 }
    );
  }

  // Validate the connection reference once, not per row.
  const connectionIds = new Set(
    input.map((t) => (typeof t.connectionId === "string" ? t.connectionId : null)).filter(Boolean) as string[]
  );
  if (connectionIds.size > 0) {
    const owned = await prisma.databaseConnection.findMany({
      where: { id: { in: [...connectionIds] }, organizationId: user.organizationId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((c) => c.id));
    const missing = [...connectionIds].filter((id) => !ownedIds.has(id));
    if (missing.length) {
      return NextResponse.json(
        {
          error: `Unknown connection: ${missing.join(", ")}.`,
          code: "NO_CONNECTION",
        },
        { status: 400 }
      );
    }
  }

  const results: Array<{
    externalKey: string;
    ok: boolean;
    id?: string;
    created?: boolean;
    error?: string;
  }> = [];

  const seen = new Set<string>();

  for (const row of input) {
    const rawKey = typeof row.externalKey === "string" ? row.externalKey.trim() : "";
    if (!rawKey) {
      results.push({ externalKey: String(row.externalKey ?? ""), ok: false, error: "externalKey is required." });
      continue;
    }

    // The tenant key ends up inside a scoped predicate, so it is checked here —
    // at configuration time, where a rejection is a form to fix rather than a
    // failed question. See lib/db/scope.ts for why this is an allow-list.
    try {
      assertSafeScopeValue(rawKey);
    } catch (err) {
      results.push({
        externalKey: rawKey,
        ok: false,
        error: err instanceof ScopeError ? err.message : "Unusable tenant key.",
      });
      continue;
    }

    if (seen.has(rawKey)) {
      results.push({ externalKey: rawKey, ok: false, error: "Duplicated within this request." });
      continue;
    }
    seen.add(rawKey);

    const status = row.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
    const label =
      typeof row.label === "string" && row.label.trim() ? row.label.trim() : rawKey;
    const connectionId = typeof row.connectionId === "string" ? row.connectionId : null;

    try {
      const existing = await prisma.tenant.findFirst({
        where: { organizationId: user.organizationId, externalKey: rawKey },
        select: { id: true },
      });
      if (existing) {
        // Idempotent: re-sending the integrator's tenant list updates it rather
        // than erroring halfway through 800 rows.
        const updated = await prisma.tenant.update({
          where: { id: existing.id },
          data: { label, status, ...(connectionId ? { connectionId } : {}) },
          select: { id: true },
        });
        results.push({ externalKey: rawKey, ok: true, id: updated.id, created: false });
      } else {
        const created = await prisma.tenant.create({
          data: {
            organizationId: user.organizationId,
            externalKey: rawKey,
            label,
            status,
            connectionId,
          },
          select: { id: true },
        });
        results.push({ externalKey: rawKey, ok: true, id: created.id, created: true });
      }
    } catch (err: any) {
      results.push({ externalKey: rawKey, ok: false, error: err?.message || "Write failed." });
    }
  }

  const created = results.filter((r) => r.ok && r.created).length;
  const updated = results.filter((r) => r.ok && !r.created).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json(
    { created, updated, failed, results },
    // A batch where some rows failed is reported as 207, not 200: a caller
    // syncing 800 clinics needs to notice the 3 that did not land.
    { status: failed === 0 ? 200 : 207 }
  );
}
