import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function owned(organizationId: string, id: string) {
  return prisma.tenant.findFirst({ where: { id, organizationId } });
}

export async function GET(
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

  const tenant = await owned(user.organizationId, params.id);
  if (!tenant) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  const [sessions, profiles, keys, liveSessions] = await Promise.all([
    prisma.chatSession.count({ where: { tenantId: tenant.id } }),
    prisma.tenantSchemaProfile.count({ where: { tenantId: tenant.id } }),
    prisma.apiKey.count({ where: { tenantId: tenant.id, revokedAt: null } }),
    prisma.embedSession.count({
      where: { tenantId: tenant.id, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  return NextResponse.json({
    tenant,
    counts: {
      sessions,
      schemaProfiles: profiles,
      activeKeys: keys,
      liveEmbedSessions: liveSessions,
    },
  });
}

export async function PATCH(
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

  const tenant = await owned(user.organizationId, params.id);
  if (!tenant) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "BAD_BODY" }, { status: 400 });
  }

  const data: {
    label?: string;
    status?: string;
    connectionId?: string | null;
    retentionDays?: number | null;
    creditAllowance?: number | null;
  } = {};

  // Null means uncapped. Setting an allowance never stops answers — it only
  // makes an overage visible while it is accruing.
  if (body.creditAllowance === null) data.creditAllowance = null;
  else if (body.creditAllowance !== undefined) {
    const calls = Number(body.creditAllowance);
    if (!Number.isInteger(calls) || calls < 0) {
      return NextResponse.json(
        { error: "Included AI requests must be a whole number, or blank for no limit.", code: "BAD_ALLOWANCE" },
        { status: 400 }
      );
    }
    data.creditAllowance = calls;
  }

  // Retention is the integrator's obligation, so it is their setting. Null
  // means "keep forever", which is a choice they have to make explicitly
  // rather than one they arrive at by not deciding.
  if (body.retentionDays === null) data.retentionDays = null;
  else if (body.retentionDays !== undefined) {
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json(
        {
          error: "Delete chats after must be between 1 and 3650 days, or blank to keep them forever.",
          code: "BAD_RETENTION",
        },
        { status: 400 }
      );
    }
    data.retentionDays = days;
  }
  if (typeof body.label === "string" && body.label.trim()) data.label = body.label.trim();
  if (body.status === "ACTIVE" || body.status === "SUSPENDED") data.status = body.status;
  if (body.connectionId === null) data.connectionId = null;
  else if (typeof body.connectionId === "string") {
    const conn = await prisma.databaseConnection.findFirst({
      where: { id: body.connectionId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!conn) {
      return NextResponse.json(
        { error: "Unknown connection.", code: "NO_CONNECTION" },
        { status: 400 }
      );
    }
    data.connectionId = conn.id;
  }

  // externalKey is deliberately not editable. It is the value the database
  // predicate matches on, and a scoped connection's verification was performed
  // against the keys as they were. Renaming one silently re-points a tenant at
  // someone else's rows; delete and re-create instead.
  if (typeof body.externalKey === "string" && body.externalKey !== tenant.externalKey) {
    return NextResponse.json(
      {
        error:
          "The ID can't be changed — it's how DAVIS finds this tenant's data. " +
          "Create a new tenant instead.",
        code: "KEY_IMMUTABLE",
      },
      { status: 400 }
    );
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update.", code: "EMPTY" }, { status: 400 });
  }

  const updated = await prisma.tenant.update({ where: { id: tenant.id }, data });

  // A tenant moved to a different connection is a tenant whose cached
  // statistics describe the wrong database.
  if (data.connectionId !== undefined) {
    await prisma.tenantSchemaProfile.deleteMany({ where: { tenantId: tenant.id } });
  }

  return NextResponse.json({ tenant: updated });
}

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

  const tenant = await owned(user.organizationId, params.id);
  if (!tenant) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  // Cascades take the tenant's conversations and cached statistics with it.
  await prisma.tenant.delete({ where: { id: tenant.id } });
  return NextResponse.json({ deleted: true, externalKey: tenant.externalKey });
}
