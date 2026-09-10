import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { hashPassword, createToken, setAuthCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Accepting an invitation. PUBLIC — the link is the credential.
 *
 * GET tells the join page who the invite is for so it can greet them by name.
 * It returns the organization and the invited name and nothing else: an invite
 * link that leaked should not also disclose the role or which tenants were
 * lined up for it.
 */

function sha256(v: string) {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

async function liveInvite(token: string) {
  const invite = await prisma.userInvite.findUnique({
    where: { tokenHash: sha256(token) },
    include: { organization: { select: { name: true } } },
  });
  if (
    !invite ||
    invite.revokedAt ||
    invite.acceptedAt ||
    invite.expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return invite;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const invite = await liveInvite(params.token);
  if (!invite) {
    return NextResponse.json(
      { error: "This invitation is no longer valid. Ask for a new one.", code: "BAD_INVITE" },
      { status: 404 }
    );
  }
  return NextResponse.json({
    name: invite.name,
    email: invite.email,
    organization: invite.organization.name,
  });
}

/** Set a password and become a member. */
export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request.", code: "BAD_BODY" }, { status: 400 });
  }

  const password = String(body.password || "");
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters.", code: "WEAK_PASSWORD" },
      { status: 400 }
    );
  }

  const invite = await liveInvite(params.token);
  if (!invite) {
    return NextResponse.json(
      { error: "This invitation is no longer valid. Ask for a new one.", code: "BAD_INVITE" },
      { status: 404 }
    );
  }

  const clash = await prisma.user.findFirst({
    where: { organizationId: invite.organizationId, email: invite.email },
    select: { id: true },
  });
  if (clash) {
    return NextResponse.json(
      { error: "That email already has an account here. Try signing in.", code: "ALREADY_MEMBER" },
      { status: 409 }
    );
  }

  let tenantIds: string[] = [];
  try {
    const parsed = JSON.parse(invite.tenantIds || "[]");
    if (Array.isArray(parsed)) tenantIds = parsed.map(String);
  } catch {
    /* an unreadable list becomes no grants, which is the safe direction */
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const made = await tx.user.create({
      data: {
        email: invite.email,
        name: invite.name,
        passwordHash,
        role: invite.role,
        tenantAccessMode: invite.tenantAccessMode,
        organizationId: invite.organizationId,
      },
      select: { id: true, name: true, email: true, role: true },
    });

    if (tenantIds.length && invite.tenantAccessMode === "LIST") {
      await tx.userTenantGrant.createMany({
        data: tenantIds.map((tenantId) => ({ userId: made.id, tenantId })),
      });
    }

    // Marked accepted rather than deleted: the invite is how this account came
    // to exist, and who created it.
    await tx.userInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    return made;
  });

  const token = await createToken({
    userId: user.id,
    email: user.email,
    organizationId: invite.organizationId,
    role: user.role,
  });

  const response = NextResponse.json({
    user,
    organization: { id: invite.organizationId, name: invite.organization.name },
  });
  return setAuthCookie(response, token);
}
