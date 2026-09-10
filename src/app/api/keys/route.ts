import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/embed/credentials";

export const dynamic = "force-dynamic";

/**
 * API key management, for the integrator's own admins.
 *
 * The secret is returned exactly once, by POST. There is no endpoint that can
 * show it again, because a store that can show a credential again is a store
 * that can leak it. Losing one is not a disaster — issue another and revoke the
 * old one, which is the workflow this is shaped around.
 */

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const url = new URL(request.url);
  const includeRevoked = url.searchParams.get("includeRevoked") === "true";

  const keys = await prisma.apiKey.findMany({
    where: {
      organizationId: user.organizationId,
      ...(includeRevoked ? {} : { revokedAt: null }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      tenantId: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
      tenant: { select: { externalKey: true, label: true } },
      // keyHash is deliberately never selected.
      _count: { select: { sessions: true } },
    },
  });

  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scope: k.tenantId ? "TENANT" : "ORGANIZATION",
      tenant: k.tenant ? { externalKey: k.tenant.externalKey, label: k.tenant.label } : null,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      sessionsMinted: k._count.sessions,
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
    return NextResponse.json({ error: "Invalid JSON body.", code: "BAD_BODY" }, { status: 400 });
  }

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : null;
  if (!name) {
    return NextResponse.json(
      {
        error: "Give the key a name, so you can recognise it later.",
        code: "NO_NAME",
      },
      { status: 400 }
    );
  }

  /* ---- Org key or tenant key? ------------------------------------------ */
  let tenantId: string | null = null;
  if (typeof body.tenantKey === "string" && body.tenantKey.trim()) {
    const tenant = await prisma.tenant.findFirst({
      where: { organizationId: user.organizationId, externalKey: body.tenantKey.trim() },
      select: { id: true },
    });
    if (!tenant) {
      return NextResponse.json(
        { error: `Unknown tenant ${JSON.stringify(body.tenantKey)}.`, code: "NO_TENANT" },
        { status: 400 }
      );
    }
    tenantId = tenant.id;
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "expiresAt must be a future date.", code: "BAD_EXPIRY" },
        { status: 400 }
      );
    }
    expiresAt = parsed;
  }

  const issued = mintApiKey();

  const created = await prisma.apiKey.create({
    data: {
      name,
      tenantId,
      organizationId: user.organizationId,
      prefix: issued.prefix,
      keyHash: issued.keyHash,
      expiresAt,
      createdBy: user.userId,
    },
    select: { id: true, name: true, prefix: true, createdAt: true, expiresAt: true },
  });

  return NextResponse.json(
    {
      key: {
        ...created,
        scope: tenantId ? "TENANT" : "ORGANIZATION",
      },
      /** Shown once. Not recoverable. */
      secret: issued.secret,
      warning:
        "This is the only time this key will be shown. Save it somewhere safe and " +
        "keep it on your server.",
    },
    { status: 201 }
  );
}
