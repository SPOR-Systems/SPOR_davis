import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Invitations: an admin adds someone and hands over a link.
 *
 * The role and tenant access are chosen here, before the person exists, so
 * nobody is ever briefly a member whose access is "whatever the default was".
 *
 * No email is sent. That is deliberate rather than lazy: sending needs SMTP
 * configured, and mail that silently fails to arrive is painful to debug and
 * looks like the product is broken. A link the admin can copy works today and
 * travels by whatever channel they already use.
 */

const INVITE_DAYS = 7;

function sha256(v: string) {
  return createHash("sha256").update(v, "utf8").digest("hex");
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

  const invites = await prisma.userInvite.findMany({
    where: { organizationId: user.organizationId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      tenantAccessMode: true,
      expiresAt: true,
      createdAt: true,
      // tokenHash is deliberately never selected.
    },
  });

  return NextResponse.json({
    invites: invites.map((i) => ({
      ...i,
      expired: i.expiresAt.getTime() <= Date.now(),
    })),
  });
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
    return NextResponse.json({ error: "Invalid request.", code: "BAD_BODY" }, { status: 400 });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address.", code: "BAD_EMAIL" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "Enter the person's name.", code: "NO_NAME" }, { status: 400 });
  }

  const existing = await prisma.user.findFirst({
    where: { organizationId: user.organizationId, email },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "That person already has an account here.", code: "ALREADY_MEMBER" },
      { status: 409 }
    );
  }

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

  const token = randomBytes(32).toString("base64url");

  const invite = await prisma.userInvite.create({
    data: {
      email,
      name,
      role,
      tenantAccessMode: mode,
      tenantIds: tenantIds.length ? JSON.stringify(tenantIds) : null,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      organizationId: user.organizationId,
      createdBy: user.userId,
    },
    select: { id: true, email: true, name: true, role: true, expiresAt: true },
  });

  return NextResponse.json(
    {
      invite,
      /** Shown once. Only its hash is stored. */
      token,
      expiresInDays: INVITE_DAYS,
    },
    { status: 201 }
  );
}

/** Revoke an invite that has not been used. */
export async function DELETE(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const id = new URL(request.url).searchParams.get("id") || "";
  const invite = await prisma.userInvite.findFirst({
    where: { id, organizationId: user.organizationId },
    select: { id: true },
  });
  if (!invite) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  await prisma.userInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ revoked: true });
}
