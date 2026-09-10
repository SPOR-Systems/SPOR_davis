import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tenantAccessFor } from "@/lib/embed/access";

export const dynamic = "force-dynamic";

/**
 * Grant management: who may query which tenants.
 *
 * GET without a userId reports the caller's own access, so the UI can decide
 * whether to render a tenant picker at all.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const url = new URL(request.url);
  const targetId = url.searchParams.get("userId");

  if (targetId && targetId !== user.userId && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const subjectId = targetId || user.userId;
  if (targetId) {
    const subject = await prisma.user.findFirst({
      where: { id: targetId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!subject) {
      return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
    }
  }

  const access = await tenantAccessFor(subjectId);
  const tenants =
    access.mode === "LIST"
      ? await prisma.tenant.findMany({
          where: { id: { in: access.tenantIds } },
          select: { id: true, externalKey: true, label: true, status: true },
          orderBy: { externalKey: "asc" },
        })
      : [];

  return NextResponse.json({ userId: subjectId, mode: access.mode, tenants });
}

/**
 * PUT — set a user's access.
 *
 * Replaces the grant set wholesale rather than patching it. "Add this one" and
 * "remove that one" are two more endpoints and two more ways for a UI to leave
 * someone holding a grant nobody meant them to have; sending the intended final
 * state means what the admin saw is what gets stored.
 */
export async function PUT(request: NextRequest) {
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

  const targetId = typeof body.userId === "string" ? body.userId : user.userId;
  const subject = await prisma.user.findFirst({
    where: { id: targetId, organizationId: user.organizationId },
    select: { id: true },
  });
  if (!subject) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  const mode = String(body.mode || "").toUpperCase();
  if (!["NONE", "LIST", "ALL"].includes(mode)) {
    return NextResponse.json(
      { error: "mode must be NONE, LIST or ALL.", code: "BAD_MODE" },
      { status: 400 }
    );
  }

  let tenantIds: string[] = [];
  if (mode === "LIST") {
    const keys: string[] = Array.isArray(body.tenantKeys)
      ? body.tenantKeys.map((k: unknown) => String(k).trim()).filter(Boolean)
      : [];
    if (keys.length === 0) {
      return NextResponse.json(
        {
          error: "Pick at least one tenant, or choose \"No access\" instead.",
          code: "EMPTY_LIST",
        },
        { status: 400 }
      );
    }
    const found = await prisma.tenant.findMany({
      where: { organizationId: user.organizationId, externalKey: { in: keys } },
      select: { id: true, externalKey: true },
    });
    const foundKeys = new Set(found.map((t) => t.externalKey));
    const missing = keys.filter((k) => !foundKeys.has(k));
    if (missing.length) {
      return NextResponse.json(
        { error: `Unknown tenant(s): ${missing.join(", ")}.`, code: "NO_TENANT" },
        { status: 400 }
      );
    }
    tenantIds = found.map((t) => t.id);
  }

  await prisma.user.update({
    where: { id: subject.id },
    data: { tenantAccessMode: mode },
  });
  await prisma.userTenantGrant.deleteMany({ where: { userId: subject.id } });
  if (tenantIds.length) {
    await prisma.userTenantGrant.createMany({
      data: tenantIds.map((tenantId) => ({
        userId: subject.id,
        tenantId,
        grantedBy: user.userId,
      })),
    });
  }

  return NextResponse.json({
    userId: subject.id,
    mode,
    granted: tenantIds.length,
  });
}
