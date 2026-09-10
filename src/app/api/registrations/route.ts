import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * People waiting to be let into this organization.
 *
 * Approving is where role and tenant access are set, in one step. Letting
 * someone in first and configuring their access afterwards leaves a window
 * where a new member's access is whatever the default happens to be, and
 * defaults are what people forget to change.
 */

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

  const requests = await prisma.pendingRegistration.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      note: true,
      createdAt: true,
      reviewedAt: true,
    },
  });

  return NextResponse.json({
    requests,
    pendingCount: requests.filter((r) => r.status === "PENDING").length,
  });
}

/** Approve or deny one request. */
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
    return NextResponse.json({ error: "Invalid request.", code: "BAD_BODY" }, { status: 400 });
  }

  const pending = await prisma.pendingRegistration.findFirst({
    where: { id: String(body.id || ""), organizationId: user.organizationId },
  });
  if (!pending) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  if (pending.status !== "PENDING") {
    return NextResponse.json(
      { error: "That request has already been dealt with.", code: "ALREADY_REVIEWED" },
      { status: 409 }
    );
  }

  /* ---- Deny ------------------------------------------------------------ */
  if (body.action === "deny") {
    await prisma.pendingRegistration.update({
      where: { id: pending.id },
      data: {
        status: "DENIED",
        note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
        reviewedAt: new Date(),
        reviewedBy: user.userId,
      },
    });
    return NextResponse.json({ denied: true });
  }

  /* ---- Approve --------------------------------------------------------- */
  const role = body.role === "ADMIN" ? "ADMIN" : "MEMBER";
  const mode = ["NONE", "LIST", "ALL"].includes(String(body.tenantAccessMode))
    ? String(body.tenantAccessMode)
    : "NONE";

  let tenantIds: string[] = [];
  if (mode === "LIST") {
    const keys: string[] = Array.isArray(body.tenantKeys)
      ? body.tenantKeys.map((k: unknown) => String(k).trim()).filter(Boolean)
      : [];
    if (keys.length === 0) {
      return NextResponse.json(
        { error: "Pick at least one tenant, or choose \"No access\" instead.", code: "EMPTY_LIST" },
        { status: 400 }
      );
    }
    const found = await prisma.tenant.findMany({
      where: { organizationId: user.organizationId, externalKey: { in: keys } },
      select: { id: true },
    });
    tenantIds = found.map((t) => t.id);
  }

  // Someone may have been added by hand while the request sat here.
  const clash = await prisma.user.findFirst({
    where: { organizationId: user.organizationId, email: pending.email },
    select: { id: true },
  });
  if (clash) {
    await prisma.pendingRegistration.delete({ where: { id: pending.id } });
    return NextResponse.json(
      { error: "That person already has an account here. The request was cleared.", code: "ALREADY_MEMBER" },
      { status: 409 }
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const made = await tx.user.create({
      data: {
        email: pending.email,
        name: pending.name,
        // The password they chose when they asked to join. Approving does not
        // make them pick another one.
        passwordHash: pending.passwordHash,
        role,
        tenantAccessMode: mode,
        organizationId: user.organizationId,
      },
      select: { id: true, name: true, email: true, role: true },
    });

    if (tenantIds.length) {
      await tx.userTenantGrant.createMany({
        data: tenantIds.map((tenantId) => ({
          userId: made.id,
          tenantId,
          grantedBy: user.userId,
        })),
      });
    }

    await tx.auditLog.create({
      data: {
        action: "registration.approved",
        details: JSON.stringify({ email: pending.email, role, tenantAccessMode: mode }),
        userId: user.userId,
        organizationId: user.organizationId,
      },
    });

    // The user is the record now; a stale approved row is one more thing that
    // could be mistaken for a live request.
    await tx.pendingRegistration.delete({ where: { id: pending.id } });
    return made;
  });

  return NextResponse.json({ approved: true, user: created });
}
