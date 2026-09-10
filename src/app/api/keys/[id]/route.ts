import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/embed/credentials";

export const dynamic = "force-dynamic";

async function owned(organizationId: string, id: string) {
  return prisma.apiKey.findFirst({ where: { id, organizationId } });
}

/**
 * POST — rotate.
 *
 * Rotation issues a NEW key and revokes the old one, rather than changing the
 * secret behind a stable id. That way a deployment mid-rotation has a moment
 * where both work if the integrator wants one (revoke later), and the audit
 * trail keeps the old key's identity instead of overwriting it.
 */
export async function POST(
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

  const existing = await owned(user.organizationId, params.id);
  if (!existing) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // Default is to revoke immediately. An integrator who needs an overlap has to
  // ask for it, because the safe default is the one where a leaked key stops
  // working now.
  const revokeOldAt =
    body.overlapSeconds && Number.isFinite(Number(body.overlapSeconds))
      ? new Date(Date.now() + Math.min(Number(body.overlapSeconds), 86_400) * 1000)
      : new Date();

  const issued = mintApiKey();

  const created = await prisma.apiKey.create({
    data: {
      name: `${existing.name} (rotated)`,
      tenantId: existing.tenantId,
      organizationId: existing.organizationId,
      prefix: issued.prefix,
      keyHash: issued.keyHash,
      expiresAt: existing.expiresAt,
      createdBy: user.userId,
    },
    select: { id: true, name: true, prefix: true, createdAt: true },
  });

  await prisma.apiKey.update({
    where: { id: existing.id },
    data: { revokedAt: revokeOldAt },
  });

  return NextResponse.json({
    key: { ...created, scope: existing.tenantId ? "TENANT" : "ORGANIZATION" },
    secret: issued.secret,
    replaced: { id: existing.id, prefix: existing.prefix, revokedAt: revokeOldAt },
    warning:
      "This is the only time this key will be shown. The previous key is revoked " +
      (revokeOldAt.getTime() > Date.now() + 1000 ? `at ${revokeOldAt.toISOString()}.` : "now."),
  });
}

/**
 * DELETE — revoke.
 *
 * A timestamp, not a row deletion. An audit trail that loses the credential a
 * request was made with is not an audit trail, and the sessions this key minted
 * still point at it.
 */
export async function DELETE(
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

  const existing = await owned(user.organizationId, params.id);
  if (!existing) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  if (existing.revokedAt) {
    return NextResponse.json({ revoked: true, alreadyRevoked: true, at: existing.revokedAt });
  }

  const now = new Date();
  await prisma.apiKey.update({ where: { id: existing.id }, data: { revokedAt: now } });

  // Revoking a key kills the sessions it minted. Otherwise a leaked key stays
  // useful for the lifetime of the last token it created, which is exactly the
  // window revocation exists to close.
  const { count } = await prisma.embedSession.updateMany({
    where: { apiKeyId: existing.id, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });

  return NextResponse.json({ revoked: true, at: now, sessionsRevoked: count });
}
