import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * ============================================================================
 *  EMBED CREDENTIALS
 * ============================================================================
 *  Two credentials, and the separation between them is the whole identity
 *  design.
 *
 *  An API KEY lives in the integrator's backend. It never reaches a browser.
 *  It can mint sessions, and that is all it can do.
 *
 *  An EMBED SESSION TOKEN is what the widget carries. It is opaque: no key, no
 *  tenant, no claims of any kind that a browser could read or alter. The tenant
 *  is looked up from the stored session row.
 *
 *      THE TENANT COMES FROM THE TOKEN RECORD, NEVER FROM THE REQUEST BODY.
 *
 *  A widget that sends a tenant key is ignored. Anything else — a signed JWT
 *  with a tenant claim, a tenant id in a header — moves the boundary into a
 *  place the browser can reach, and the browser is the one participant that is
 *  never trusted.
 *
 *  WHY OPAQUE RATHER THAN A JWT
 *  ----------------------------
 *  No signing key to distribute, no clock skew, and — the reason that actually
 *  matters — a session can be REVOKED BEFORE IT EXPIRES. A JWT is valid until
 *  it isn't; the day an integrator discovers one of their users should not have
 *  had access, "wait fifteen minutes" is not an answer.
 *
 *  WHAT IS STORED
 *  --------------
 *  Only hashes. A store that can show a credential again is a store that can
 *  leak it, so the secret is displayed once at creation and never recoverable.
 *  Lookup is by hash, which is exact — there is no scan of candidate rows and
 *  no per-row comparison to get wrong.
 * ============================================================================
 */

const KEY_PREFIX = "dk_live_";
const TOKEN_PREFIX = "des_";

/** Bytes of entropy. 32 bytes is 256 bits; guessing is not the attack. */
const KEY_BYTES = 32;
const TOKEN_BYTES = 32;

export const DEFAULT_SESSION_TTL_SECONDS = 900; // 15 minutes
export const MAX_SESSION_TTL_SECONDS = 86_400; // 24 hours
export const MIN_SESSION_TTL_SECONDS = 60;

export class EmbedAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 401
  ) {
    super(message);
    this.name = "EmbedAuthError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * url-safe base64 without padding. Keys get pasted into config files, curl
 * commands and environment variables; `+`, `/` and `=` all cause trouble in at
 * least one of those.
 */
function randomSecret(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

export interface IssuedKey {
  /** Shown ONCE. Not stored anywhere in recoverable form. */
  secret: string;
  prefix: string;
  keyHash: string;
}

/**
 * The prefix is a stable, non-secret handle: enough to recognise a key in a
 * list or a support ticket, not enough to be one. It is stored in the clear and
 * carried in the key itself so a pasted key can be identified without hashing.
 */
export function mintApiKey(): IssuedKey {
  const body = randomSecret(KEY_BYTES);
  const secret = `${KEY_PREFIX}${body}`;
  return {
    secret,
    prefix: secret.slice(0, KEY_PREFIX.length + 8),
    keyHash: sha256(secret),
  };
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX);
}

export interface ResolvedApiKey {
  id: string;
  organizationId: string;
  /** Null for an org key. */
  tenantId: string | null;
  name: string;
  prefix: string;
}

/**
 * Resolve a presented key, or throw.
 *
 * Every rejection here is deliberately indistinguishable in shape from the
 * others: an unknown key, a revoked key and an expired key all produce the same
 * status and a message that does not say which. Telling a caller "that key
 * exists but is revoked" tells them the key exists.
 */
export async function resolveApiKey(presented: string): Promise<ResolvedApiKey> {
  const value = (presented || "").trim();
  if (!value || !looksLikeApiKey(value)) {
    throw new EmbedAuthError("Invalid API key.", "BAD_KEY");
  }

  const row = await prisma.apiKey.findUnique({
    where: { keyHash: sha256(value) },
    select: {
      id: true,
      organizationId: true,
      tenantId: true,
      name: true,
      prefix: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
    throw new EmbedAuthError("Invalid API key.", "BAD_KEY");
  }

  // Best-effort, and deliberately not awaited into the critical path: a busy
  // integrator makes this write on every session mint, and a failed bookkeeping
  // update must never fail a request that is otherwise fine.
  prisma.apiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    id: row.id,
    organizationId: row.organizationId,
    tenantId: row.tenantId,
    name: row.name,
    prefix: row.prefix,
  };
}

/* -------------------------------------------------------------------------- */
/* Session tokens                                                             */
/* -------------------------------------------------------------------------- */

export interface IssuedToken {
  secret: string;
  prefix: string;
  tokenHash: string;
}

export function mintSessionToken(): IssuedToken {
  const body = randomSecret(TOKEN_BYTES);
  const secret = `${TOKEN_PREFIX}${body}`;
  return {
    secret,
    prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
    tokenHash: sha256(secret),
  };
}

export function looksLikeSessionToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

export interface ResolvedEmbedSession {
  id: string;
  organizationId: string;
  tenantId: string;
  /** The integrator's key for this tenant — what the scope resolver matches on. */
  tenantKey: string;
  endUserId: string | null;
  allowedOrigin: string | null;
  expiresAt: Date;
}

/**
 * Resolve a widget's token into the identity a question will run under.
 *
 * The tenant's status is re-read on every request rather than baked into the
 * token at mint time. Suspending a tenant has to stop its sessions NOW — one
 * flag driving both billing and refusal, with no window in which an integrator
 * is not paying but the widget still answers.
 */
export async function resolveEmbedSession(
  presented: string,
  opts: { origin?: string | null } = {}
): Promise<ResolvedEmbedSession> {
  const value = (presented || "").trim();
  if (!value || !looksLikeSessionToken(value)) {
    throw new EmbedAuthError("Invalid or expired session.", "BAD_SESSION");
  }

  const row = await prisma.embedSession.findUnique({
    where: { tokenHash: sha256(value) },
    include: { tenant: { select: { externalKey: true, status: true } } },
  });

  if (
    !row ||
    row.revokedAt ||
    row.expiresAt.getTime() <= Date.now() ||
    !row.tenant
  ) {
    throw new EmbedAuthError("Invalid or expired session.", "BAD_SESSION");
  }

  if (row.tenant.status !== "ACTIVE") {
    throw new EmbedAuthError(
      "This tenant is suspended.",
      "TENANT_SUSPENDED",
      403
    );
  }

  if (row.allowedOrigin) {
    const seen = (opts.origin || "").trim();
    // Compared byte-for-byte after normalising the trailing slash. Origins are
    // short and known, so there is nothing to gain from a looser match and a
    // great deal to lose: "starts with" would let evil-example.com.attacker.net
    // through.
    if (normaliseOrigin(seen) !== normaliseOrigin(row.allowedOrigin)) {
      throw new EmbedAuthError(
        "This session is pinned to a different origin.",
        "BAD_ORIGIN",
        403
      );
    }
  }

  prisma.embedSession
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    id: row.id,
    organizationId: row.organizationId,
    tenantId: row.tenantId,
    tenantKey: row.tenant.externalKey,
    endUserId: row.endUserId,
    allowedOrigin: row.allowedOrigin,
    expiresAt: row.expiresAt,
  };
}

function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Constant-time comparison, for the one place a secret is compared rather than
 * looked up by hash. Not used on the hot paths above — a hash lookup has no
 * timing signal to leak — but exported so nothing reaches for `===` later.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The Authorization header, or null. */
export function bearerFrom(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}
