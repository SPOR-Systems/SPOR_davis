import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  EmbedAuthError,
  bearerFrom,
  resolveApiKey,
  resolveEmbedSession,
  mintSessionToken,
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
} from "@/lib/embed/credentials";

export const dynamic = "force-dynamic";

/**
 * ============================================================================
 *  POST /api/embed/sessions   —   server to server
 * ============================================================================
 *  The integrator's BACKEND calls this with an API key that never reaches a
 *  browser, and gets back an opaque token for one tenant and one end user.
 *
 *      POST /api/embed/sessions
 *      Authorization: Bearer dk_live_...
 *      { "tenantKey": "clinic_4471", "endUserId": "u_99", "ttlSeconds": 900 }
 *
 *      -> { "token": "des_...", "expiresAt": "..." }
 *
 *  The widget then carries only that token. It has no key, no tenant, and no
 *  claims it could alter — which is what makes the browser's dishonesty
 *  uninteresting.
 *
 *  This endpoint is the thing that must not be abused: it is where authority is
 *  created. So it refuses more than it corrects. A tenant key asked for a
 *  different tenant is REFUSED rather than quietly given its own tenant, because
 *  a caller who asked for the wrong thing has a bug, and answering the question
 *  they did not ask hides it.
 * ============================================================================
 */

/** Never let an unauthenticated caller learn anything from timing or wording. */
function unauthorized(error: EmbedAuthError) {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: error.status }
  );
}

export async function POST(request: NextRequest) {
  const presented = bearerFrom(request);
  if (!presented) {
    return NextResponse.json(
      {
        error: "An API key is required. Send it as: Authorization: Bearer dk_live_...",
        code: "NO_KEY",
      },
      { status: 401 }
    );
  }

  let key;
  try {
    key = await resolveApiKey(presented);
  } catch (error) {
    if (error instanceof EmbedAuthError) return unauthorized(error);
    throw error;
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const requestedTenant =
    typeof body.tenantKey === "string" ? body.tenantKey.trim() : "";

  /* ---- Which tenant is this session for? ------------------------------- */
  // A tenant key already answers this. An org key must be told, because an org
  // key that defaulted to "some tenant" would be a way to get the wrong one.
  let tenantId: string;
  if (key.tenantId) {
    if (requestedTenant) {
      const owned = await prisma.tenant.findUnique({
        where: { id: key.tenantId },
        select: { externalKey: true },
      });
      if (!owned || owned.externalKey !== requestedTenant) {
        return NextResponse.json(
          {
            error:
              "This key belongs to a single tenant and cannot mint a session for " +
              "another one.",
            code: "TENANT_NOT_PERMITTED",
          },
          { status: 403 }
        );
      }
    }
    tenantId = key.tenantId;
  } else {
    if (!requestedTenant) {
      return NextResponse.json(
        {
          error:
            "tenantKey is required with an organization key. Use a tenant key, or " +
            "name the tenant this session is for.",
          code: "NO_TENANT",
        },
        { status: 400 }
      );
    }
    const tenant = await prisma.tenant.findFirst({
      where: { organizationId: key.organizationId, externalKey: requestedTenant },
      select: { id: true },
    });
    if (!tenant) {
      return NextResponse.json(
        { error: `Unknown tenant ${JSON.stringify(requestedTenant)}.`, code: "NO_TENANT" },
        { status: 404 }
      );
    }
    tenantId = tenant.id;
  }

  /* ---- Is the tenant allowed to answer at all? ------------------------- */
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { externalKey: true, status: true, organizationId: true },
  });
  if (!tenant || tenant.organizationId !== key.organizationId) {
    return NextResponse.json(
      { error: "Unknown tenant.", code: "NO_TENANT" },
      { status: 404 }
    );
  }
  if (tenant.status !== "ACTIVE") {
    // One flag, both effects: a suspended tenant stops billing and stops
    // answering at the same instant. There is no state where an integrator is
    // not paying but the widget still works.
    return NextResponse.json(
      { error: "This tenant is suspended.", code: "TENANT_SUSPENDED" },
      { status: 403 }
    );
  }

  /* ---- Lifetime -------------------------------------------------------- */
  // Short by default. The token is the thing a browser holds, so its lifetime
  // is the window in which a stolen one is useful; minting another is one
  // server-to-server call.
  let ttl = Number(body.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(ttl)) ttl = DEFAULT_SESSION_TTL_SECONDS;
  ttl = Math.min(Math.max(Math.floor(ttl), MIN_SESSION_TTL_SECONDS), MAX_SESSION_TTL_SECONDS);

  const endUserId =
    typeof body.endUserId === "string" && body.endUserId.trim()
      ? body.endUserId.trim().slice(0, 200)
      : null;

  const allowedOrigin =
    typeof body.allowedOrigin === "string" && body.allowedOrigin.trim()
      ? body.allowedOrigin.trim().slice(0, 300)
      : null;

  const token = mintSessionToken();
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await prisma.embedSession.create({
    data: {
      tokenHash: token.tokenHash,
      prefix: token.prefix,
      organizationId: key.organizationId,
      tenantId,
      apiKeyId: key.id,
      endUserId,
      allowedOrigin,
      expiresAt,
    },
  });

  return NextResponse.json(
    {
      // Returned once. Only its hash is stored, so it cannot be re-read later.
      token: token.secret,
      expiresAt: expiresAt.toISOString(),
      // Echoed so the integrator can assert on it in their own tests. It comes
      // from the resolved record, not from what they sent.
      tenantKey: tenant.externalKey,
      endUserId,
    },
    { status: 201 }
  );
}

/**
 * DELETE — revoke a session before it expires.
 *
 * This is the reason the token is opaque rather than a JWT. A signed token is
 * valid until it isn't; when an integrator discovers one of their users should
 * not have had access, "wait for it to expire" is not an answer.
 */
export async function DELETE(request: NextRequest) {
  const presented = bearerFrom(request);
  if (!presented) {
    return NextResponse.json({ error: "An API key is required.", code: "NO_KEY" }, { status: 401 });
  }

  let key;
  try {
    key = await resolveApiKey(presented);
  } catch (error) {
    if (error instanceof EmbedAuthError) return unauthorized(error);
    throw error;
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const now = new Date();

  // Revoke one session by its token, or every session for an end user, or every
  // session for a tenant. The third is what gets used at three in the morning.
  if (typeof body.token === "string" && body.token.trim()) {
    let session;
    try {
      session = await resolveEmbedSession(body.token);
    } catch {
      // Already invalid, so the caller's intent is satisfied either way. Saying
      // "no such session" would confirm which tokens exist.
      return NextResponse.json({ revoked: 0 });
    }
    if (session.organizationId !== key.organizationId) {
      return NextResponse.json({ revoked: 0 });
    }
    if (key.tenantId && session.tenantId !== key.tenantId) {
      return NextResponse.json({ revoked: 0 });
    }
    await prisma.embedSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
    return NextResponse.json({ revoked: 1 });
  }

  const tenantKey = typeof body.tenantKey === "string" ? body.tenantKey.trim() : "";
  const endUserId = typeof body.endUserId === "string" ? body.endUserId.trim() : "";

  if (!tenantKey && !endUserId) {
    return NextResponse.json(
      {
        error: "Supply a token, a tenantKey, or an endUserId to revoke.",
        code: "NOTHING_TO_REVOKE",
      },
      { status: 400 }
    );
  }

  let tenantId: string | null = key.tenantId;
  if (tenantKey) {
    const tenant = await prisma.tenant.findFirst({
      where: { organizationId: key.organizationId, externalKey: tenantKey },
      select: { id: true },
    });
    if (!tenant) return NextResponse.json({ revoked: 0 });
    if (key.tenantId && key.tenantId !== tenant.id) {
      return NextResponse.json(
        {
          error: "This key belongs to a different tenant.",
          code: "TENANT_NOT_PERMITTED",
        },
        { status: 403 }
      );
    }
    tenantId = tenant.id;
  }

  const { count } = await prisma.embedSession.updateMany({
    where: {
      organizationId: key.organizationId,
      ...(tenantId ? { tenantId } : {}),
      ...(endUserId ? { endUserId } : {}),
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { revokedAt: now },
  });

  return NextResponse.json({ revoked: count });
}
