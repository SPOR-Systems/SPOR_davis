import { prisma } from "@/lib/prisma";

/**
 * ============================================================================
 *  TENANT ACCESS — who may point at which tenant
 * ============================================================================
 *  Cross-tenant access is an AUTHORIZATION question, not a data-scoping one.
 *
 *  This is the distinction the whole design turns on, so it is worth stating
 *  flatly: the data predicate is `= 'one tenant'` in every case, for every
 *  principal, forever. A head-office master reading Store B gets byte-for-byte
 *  the surface Store B's own staff get. There is no privileged query path, no
 *  IN-list, and no state in which an open handle can see two tenants.
 *
 *  What varies is only which tenants a person may CHOOSE. That question is
 *  answered here, before `resolveScope` is called and before any connection is
 *  opened — which is what keeps the security-critical module (`db/scope.ts`)
 *  small and ignorant of who is asking.
 *
 *  THE ADMIN RULE
 *  --------------
 *  An organization ADMIN with no explicit mode resolves to ALL. This does not
 *  hand them anything they did not have: an admin can already read every
 *  connection's stored credentials and reconfigure its scoping, so they already
 *  have effective access to every tenant. Encoding that plainly beats a rule
 *  that pretends otherwise while being trivially bypassable.
 *
 *  An explicit mode always wins, so an admin CAN be narrowed to a list.
 * ============================================================================
 */

export type TenantAccessMode = "NONE" | "LIST" | "ALL";

export class TenantAccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 403
  ) {
    super(message);
    this.name = "TenantAccessError";
  }
}

export interface TenantAccess {
  mode: TenantAccessMode;
  /** Populated for LIST only. ALL is deliberately not enumerated. */
  tenantIds: string[];
}

function normaliseMode(raw: string | null | undefined): TenantAccessMode | null {
  const value = String(raw || "").toUpperCase();
  return value === "ALL" || value === "LIST" || value === "NONE"
    ? (value as TenantAccessMode)
    : null;
}

/**
 * What this user is allowed to reach.
 *
 * ALL is never expanded into a list of ids. At 4,000 tenants that would be
 * 4,000 rows read to answer a yes/no question, and the expansion would then
 * have to be kept fresh as tenants are added — a cache with a correctness
 * requirement, invented for no reason.
 */
export async function tenantAccessFor(userId: string): Promise<TenantAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, tenantAccessMode: true },
  });
  if (!user) return { mode: "NONE", tenantIds: [] };

  const explicit = normaliseMode(user.tenantAccessMode);
  const mode: TenantAccessMode =
    explicit && explicit !== "NONE"
      ? explicit
      : user.role === "ADMIN"
      ? "ALL"
      : explicit ?? "NONE";

  if (mode !== "LIST") return { mode, tenantIds: [] };

  const grants = await prisma.userTenantGrant.findMany({
    where: { userId },
    select: { tenantId: true },
  });
  return { mode, tenantIds: grants.map((g) => g.tenantId) };
}

export interface AuthorizedTenant {
  id: string;
  externalKey: string;
  label: string;
  /** The tenant's own database, when it has one. */
  connectionId?: string | null;
  connectionName?: string | null;
}

/**
 * Resolve a tenant key this user is entitled to query, or throw.
 *
 * Deliberately one function rather than a "check" and a "load": splitting them
 * invites a caller to load the tenant, forget the check, and ship something
 * that works perfectly in testing. Here the only way to get a tenant is to have
 * been authorized for it.
 */
export async function authorizeTenant(
  userId: string,
  organizationId: string,
  tenantKey: string
): Promise<AuthorizedTenant> {
  const key = String(tenantKey || "").trim();
  if (!key) {
    throw new TenantAccessError("No tenant was named.", "NO_TENANT", 400);
  }

  const access = await tenantAccessFor(userId);
  if (access.mode === "NONE") {
    throw new TenantAccessError(
      "You do not have access to any tenant on this organization.",
      "NO_TENANT_ACCESS"
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { organizationId, externalKey: key },
    select: { id: true, externalKey: true, label: true, status: true },
  });

  // An unknown tenant and an ungranted one return the SAME error. Saying "that
  // tenant exists, you just cannot see it" tells a user which of their
  // competitors is a customer.
  const denied = () =>
    new TenantAccessError(
      `You do not have access to tenant ${JSON.stringify(key)}.`,
      "TENANT_FORBIDDEN"
    );

  if (!tenant) throw denied();
  if (access.mode === "LIST" && !access.tenantIds.includes(tenant.id)) throw denied();

  if (tenant.status !== "ACTIVE") {
    throw new TenantAccessError(
      `Tenant ${JSON.stringify(key)} is suspended.`,
      "TENANT_SUSPENDED"
    );
  }

  return { id: tenant.id, externalKey: tenant.externalKey, label: tenant.label };
}

/**
 * The tenants to show in a picker.
 *
 * Capped, because a master at an integrator with 4,000 stores would otherwise
 * pull all of them into a dropdown that is unusable anyway. The caller passes a
 * search term; the UI is a search box, not a list.
 */
export async function listAccessibleTenants(
  userId: string,
  organizationId: string,
  opts: { search?: string; take?: number } = {}
): Promise<{ mode: TenantAccessMode; tenants: AuthorizedTenant[]; total: number }> {
  const access = await tenantAccessFor(userId);
  if (access.mode === "NONE") return { mode: "NONE", tenants: [], total: 0 };

  const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
  const search = (opts.search || "").trim();

  const where = {
    organizationId,
    status: "ACTIVE",
    ...(access.mode === "LIST" ? { id: { in: access.tenantIds } } : {}),
    ...(search
      ? { OR: [{ externalKey: { contains: search } }, { label: { contains: search } }] }
      : {}),
  };

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      orderBy: { externalKey: "asc" },
      take,
      select: {
        id: true,
        externalKey: true,
        label: true,
        connectionId: true,
        // Carried so the chat can pick the database from the tenant without a
        // second round trip — and without a non-admin ever calling the
        // connections endpoint, which they should not be able to read at all.
        connection: { select: { name: true } },
      },
    }),
    prisma.tenant.count({ where }),
  ]);

  return {
    mode: access.mode,
    tenants: tenants.map((t) => ({
      id: t.id,
      externalKey: t.externalKey,
      label: t.label,
      connectionId: t.connectionId,
      connectionName: t.connection?.name ?? null,
    })),
    total,
  };
}

/* -------------------------------------------------------------------------- */
/* Connections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A TENANT IS A DATABASE.
 *
 * In the common shape, each of the integrator's customers has its own database
 * — HealthP sells an EMR, and every clinic running it has its own. So being
 * granted a tenant has to mean being able to reach that tenant's database, and
 * nothing else.
 *
 * That was the hole. Tenant grants controlled which tenant a question ran AS,
 * but the list of databases came back unfiltered — so someone granted only
 * Clinic A could pick Clinic B's database from the dropdown and query all of
 * it. The grant was real and the door beside it was open.
 *
 * The other shape still exists and still works: many tenants inside ONE
 * database, told apart by a column (see db/scope.ts). Those tenants have no
 * connection of their own, and reaching that shared database is governed by
 * row-level scoping rather than by this check.
 */

/** Connection ids this person may query, or `null` meaning "no restriction". */
export async function accessibleConnectionIds(
  userId: string,
  organizationId: string
): Promise<string[] | null> {
  const access = await tenantAccessFor(userId);
  if (access.mode === "ALL") return null;
  if (access.mode === "NONE") return [];

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: access.tenantIds }, organizationId },
    select: { connectionId: true },
  });

  return [
    ...new Set(
      tenants.map((t) => t.connectionId).filter((id): id is string => !!id)
    ),
  ];
}

/**
 * Refuse unless this person may query this database.
 *
 * Called on the question path, not only where the dropdown is built. Filtering
 * a list is a courtesy to the user interface; this is the part that decides.
 */
export async function assertConnectionAllowed(
  userId: string,
  organizationId: string,
  connectionId: string
): Promise<void> {
  const allowed = await accessibleConnectionIds(userId, organizationId);
  if (allowed === null) return;

  if (allowed.length === 0) {
    throw new TenantAccessError(
      "You don't have access to any databases yet. Ask an administrator to give " +
        "you access to a tenant.",
      "NO_TENANT_ACCESS"
    );
  }

  if (!allowed.includes(connectionId)) {
    // Same wording whether the database is someone else's or does not exist:
    // "that one isn't yours" still tells you it is somebody's.
    throw new TenantAccessError(
      "You don't have access to that database.",
      "CONNECTION_FORBIDDEN"
    );
  }
}

/**
 * The tenant a connection belongs to, when it belongs to exactly one.
 *
 * With a database per tenant, choosing the database has already chosen the
 * tenant — asking someone to pick it a second time is asking them to repeat
 * themselves. Returns null for a shared database, where the question genuinely
 * is ambiguous and the tenant has to be named.
 */
export async function soleTenantOfConnection(
  organizationId: string,
  connectionId: string
): Promise<{ id: string; externalKey: string } | null> {
  const tenants = await prisma.tenant.findMany({
    where: { organizationId, connectionId, status: "ACTIVE" },
    select: { id: true, externalKey: true },
    take: 2,
  });
  return tenants.length === 1 ? tenants[0]! : null;
}

/**
 * A named tenant must own the database being queried.
 *
 * THIS IS THE CHECK THAT WAS MISSING.
 *
 * Naming a tenant and then querying a different database used to be accepted
 * in silence: `resolveScope` sees an unscoped connection, discards the tenant
 * and runs the question against everything. So the interface said "DemoTenant1"
 * while the answer came from an entirely unrelated database — and it looked
 * like it had worked.
 *
 * A tenant is a database. Either the tenant owns this one, or this one is a
 * shared database whose row-level scoping does the separating. Anything else is
 * a mismatch, and a mismatch is refused rather than quietly resolved in
 * whichever direction happens to be convenient.
 */
export async function assertTenantOwnsConnection(
  organizationId: string,
  tenantId: string,
  connectionId: string
): Promise<void> {
  const [tenant, connection] = await Promise.all([
    prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
      select: { label: true, connectionId: true },
    }),
    prisma.databaseConnection.findFirst({
      where: { id: connectionId, organizationId },
      select: { name: true, scopeMode: true },
    }),
  ]);

  if (!tenant || !connection) {
    throw new TenantAccessError("Unknown tenant or database.", "NO_TENANT", 404);
  }

  // The tenant has its own database: it must be this one.
  if (tenant.connectionId) {
    if (tenant.connectionId !== connectionId) {
      throw new TenantAccessError(
        `${tenant.label} doesn't use ${connection.name}. Choose ${tenant.label} ` +
          `and DAVIS will use its own database.`,
        "TENANT_CONNECTION_MISMATCH"
      );
    }
    return;
  }

  // No database of its own — legitimate only when several tenants share one and
  // a column tells them apart. On an unscoped database there is nothing to keep
  // this tenant inside its own rows, so the question does not run.
  if (!connection.scopeMode || connection.scopeMode === "NONE") {
    throw new TenantAccessError(
      `${tenant.label} has no database of its own, and ${connection.name} has no ` +
        `data separation set up — so there is no way to show only ${tenant.label}'s ` +
        `data. Link a database to this tenant, or set up data separation.`,
      "TENANT_NOT_SEPARABLE"
    );
  }
}
