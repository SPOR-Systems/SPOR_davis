import { prisma } from "@/lib/prisma";
import { decryptText } from "@/lib/encryption";
import {
  openConnection,
  type DbCredentials,
  type DbHandle,
  type Dialect,
} from "@/lib/db/connection";

/**
 * ============================================================================
 *  ROW-LEVEL SCOPING
 * ============================================================================
 *  Turns (connection, tenant) into a database surface the query cannot escape.
 *
 *  THE GOVERNING RULE
 *  ------------------
 *  Scoping is enforced by shrinking what is VISIBLE, never by rewriting the
 *  query. The obvious approach — parse the model's SQL and bolt on a
 *  "WHERE tenant = ..." — needs a real per-dialect parser and has to handle
 *  CTEs, correlated subqueries, lateral joins, UNION and derived tables
 *  correctly. Every bug in that is a data leak rather than a wrong answer.
 *
 *  So the only readable objects are ones that are already filtered. The planner
 *  cannot write an unscoped query because there is nothing unscoped to name.
 *
 *  Nothing here depends on the model behaving. A prompt rule is not a security
 *  control: the planner can omit it, the repair loop can drop it while fixing an
 *  unrelated error, and a question containing instructions can talk it out of it.
 * ============================================================================
 */

export type ScopeMode =
  | "NONE"
  | "SEPARATE_CREDENTIALS"
  | "NATIVE_RLS"
  | "MANAGED_VIEWS";

/** Prefix for the temporary views MANAGED_VIEWS creates. */
export const SCOPED_VIEW_PREFIX = "davis_";

export class ScopeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export interface ScopeContext {
  mode: ScopeMode;
  /** DAVIS's own id. Null for an unscoped connection. */
  tenantId: string | null;
  /** The integrator's key — the value that reaches the predicate. */
  tenantKey: string | null;
  /**
   * The complete set of objects a query may name.
   *
   * Empty means unrestricted, which is only ever true for NONE. Every other
   * mode populates this, and guardQuery refuses anything outside it.
   */
  allowedObjects: string[];
  /** Credentials to open with; a tenant may have its own. */
  credentials: DbCredentials;
}

/* -------------------------------------------------------------------------- */
/* Validating the value that reaches the database                             */
/* -------------------------------------------------------------------------- */

/**
 * Every dialect here inlines the tenant key into statement text. The driver
 * interface DAVIS uses (`DbHandle.run(sql)`) has no bound-parameter channel,
 * and the two statements that carry the key — Postgres `set_config` and a
 * SQLite view's DDL — could not use one anyway: a view definition is text, not
 * a parameterisable expression. So the key is validated instead of escaped.
 *
 * This is an ALLOW-LIST, not an escape. Escaping is a game of finding the
 * character you forgot; refusing anything that is not a plausible identifier is
 * a game with no moves. An integrator whose tenant keys contain quotes has a
 * problem worth hearing about at configuration time rather than at exploit time.
 */
const SAFE_SCOPE_VALUE = /^[A-Za-z0-9_.:@-]{1,128}$/;

export function assertSafeScopeValue(value: string): string {
  if (!SAFE_SCOPE_VALUE.test(value)) {
    throw new ScopeError(
      `Tenant key ${JSON.stringify(value.slice(0, 32))} contains characters that ` +
        `cannot be safely used in a scoped query. Allowed: letters, digits, and ` +
        `. _ - : @`,
      "UNSAFE_SCOPE_VALUE"
    );
  }
  return value;
}

/** Identifiers are never quoted from user input either. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function assertSafeIdentifier(name: string, what: string): string {
  // A schema-qualified name is two identifiers, each checked on its own.
  const parts = String(name || "").split(".");
  if (parts.length === 0 || parts.length > 2 || !parts.every((p) => SAFE_IDENTIFIER.test(p))) {
    throw new ScopeError(
      `${what} ${JSON.stringify(String(name).slice(0, 40))} is not a usable identifier.`,
      "UNSAFE_IDENTIFIER"
    );
  }
  return parts.join(".");
}

/** The temp view that stands in for a base table. */
export function scopedViewName(table: string): string {
  const leaf = table.includes(".") ? table.split(".").pop()! : table;
  return `${SCOPED_VIEW_PREFIX}${leaf}`;
}

function parseTables(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Engine capability                                                          */
/* -------------------------------------------------------------------------- */

/**
 * MANAGED_VIEWS needs temporary views, and MySQL does not have them.
 *
 * MySQL supports TEMPORARY TABLES but not TEMPORARY VIEWS, and its persistent
 * views may not reference user variables — so there is no way to build a view
 * whose filter changes per session. The alternatives are all worse than saying
 * so: one persistent view per tenant per table is 80,000 objects at 4,000
 * tenants, and a temporary TABLE materialises a copy of the data on every
 * question.
 *
 * A MySQL integrator with a shared schema needs SEPARATE_CREDENTIALS — a
 * database user per tenant — or their own definer-based views. Refusing at
 * configuration time is far better than a mode that half works.
 */
export function supportsManagedViews(dialect: Dialect): boolean {
  return dialect === "POSTGRESQL" || dialect === "SQLITE";
}

/* -------------------------------------------------------------------------- */
/* Resolving a scope                                                          */
/* -------------------------------------------------------------------------- */

export async function resolveScope(args: {
  connectionId: string;
  organizationId: string;
  /** The integrator's tenant key. Absent means an unscoped request. */
  tenantKey?: string | null;
  /** True for embedded requests, which may never run against a NONE connection. */
  requireScope?: boolean;
  /**
   * Set ONLY by the isolation check in verifyScope.ts, which has to open a
   * scoped connection in order to establish that the scoping works. Nothing on
   * a question-answering path may pass this: it is the one door past the
   * "unverified connections do not answer" rule, and it exists so that door can
   * be opened from the inside.
   */
  forVerification?: boolean;
}): Promise<ScopeContext> {
  const { connectionId, organizationId, tenantKey, requireScope } = args;

  const conn = await prisma.databaseConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!conn) {
    throw new ScopeError("Database connection not found.", "NO_CONNECTION");
  }

  const mode = (conn.scopeMode || "NONE") as ScopeMode;

  const baseCredentials: DbCredentials = {
    id: conn.id,
    type: conn.type,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    password: decryptText(conn.encryptedPassword),
    ssl: conn.ssl,
  };

  /* ---- Unscoped ------------------------------------------------------- */
  if (mode === "NONE") {
    // An embedded session must never reach here. Refusing rather than quietly
    // running unscoped is the difference between a configuration mistake and a
    // breach.
    if (requireScope) {
      throw new ScopeError(
        "Data separation is not set up on this connection, so it can't be used " +
          "by customers.",
        "SCOPE_REQUIRED"
      );
    }
    return {
      mode,
      tenantId: null,
      tenantKey: null,
      allowedObjects: [],
      credentials: baseCredentials,
    };
  }

  /* ---- Everything below is scoped and must have a tenant -------------- */
  if (!tenantKey) {
    throw new ScopeError(
      "Choose which tenant you're asking about.",
      "TENANT_REQUIRED"
    );
  }

  if (!conn.verifiedAt && !args.forVerification) {
    // A scoped connection that has never proven it isolates is more dangerous
    // than an unscoped one, because everyone believes it is safe.
    throw new ScopeError(
      "This connection hasn't been tested yet. Open Connections → Data separation " +
        "and run the test before asking questions.",
      "NOT_VERIFIED"
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { organizationId, externalKey: tenantKey },
  });
  if (!tenant) {
    throw new ScopeError(`Unknown tenant ${JSON.stringify(tenantKey)}.`, "NO_TENANT");
  }
  if (tenant.status !== "ACTIVE") {
    throw new ScopeError(
      `${tenantKey} is paused.`,
      "TENANT_SUSPENDED"
    );
  }

  assertSafeScopeValue(tenant.externalKey);

  const tables = parseTables(conn.scopedTables);
  if (tables.length === 0) {
    throw new ScopeError(
      "No tables are listed as readable on this connection, so there is nothing " +
        "to answer from.",
      "NO_SCOPED_TABLES"
    );
  }
  for (const t of tables) assertSafeIdentifier(t, "Scoped table");

  /* ---- Per-tenant credentials ----------------------------------------- */
  if (mode === "SEPARATE_CREDENTIALS") {
    const override = await prisma.connectionScopeCredential.findFirst({
      where: { connectionId: conn.id, scopeKey: tenant.externalKey },
    });
    if (!override) {
      throw new ScopeError(
        `No credentials are registered for tenant ${JSON.stringify(tenantKey)}.`,
        "NO_SCOPE_CREDENTIALS"
      );
    }
    return {
      mode,
      tenantId: tenant.id,
      tenantKey: tenant.externalKey,
      // Isolation is the connection itself, so the base tables are readable —
      // but still only the ones that were declared.
      allowedObjects: tables,
      credentials: {
        ...baseCredentials,
        database: override.database || baseCredentials.database,
        username: override.username || baseCredentials.username,
        password: override.encryptedPassword
          ? decryptText(override.encryptedPassword)
          : baseCredentials.password,
      },
    };
  }

  /* ---- Engine enforces it --------------------------------------------- */
  if (mode === "NATIVE_RLS") {
    if (!conn.scopeSetting) {
      throw new ScopeError(
        "This connection uses native row-level security but no session setting " +
          "is configured for the tenant value.",
        "NO_SCOPE_SETTING",
      );
    }
    assertSafeIdentifier(conn.scopeSetting.replace(".", "_"), "Scope setting");
    return {
      mode,
      tenantId: tenant.id,
      tenantKey: tenant.externalKey,
      allowedObjects: tables,
      credentials: baseCredentials,
    };
  }

  /* ---- Temporary filtered views --------------------------------------- */
  const dialect = conn.type.toUpperCase() as Dialect;
  if (!supportsManagedViews(dialect)) {
    throw new ScopeError(
      `${conn.type} cannot use managed views: it has no temporary views, and its ` +
        `persistent views cannot reference a session variable. Use separate ` +
        `credentials per tenant instead.`,
      "MODE_UNSUPPORTED"
    );
  }
  if (!conn.scopeColumn) {
    throw new ScopeError(
      "This connection uses managed views but no tenant column is configured.",
      "NO_SCOPE_COLUMN"
    );
  }
  assertSafeIdentifier(conn.scopeColumn, "Scope column");

  return {
    mode,
    tenantId: tenant.id,
    tenantKey: tenant.externalKey,
    // Only the views. The base tables are deliberately absent, so a query
    // naming one is rejected by the guard.
    allowedObjects: tables.map(scopedViewName),
    credentials: baseCredentials,
  };
}

/* -------------------------------------------------------------------------- */
/* Applying a scope to an open connection                                     */
/* -------------------------------------------------------------------------- */

/**
 * Make the handle see only the tenant's rows.
 *
 * Called immediately after opening and before anything else runs. If it throws,
 * the caller must close the handle and refuse the question — a handle that
 * failed to be scoped is an unscoped handle.
 */
export async function applyScope(
  handle: DbHandle,
  scope: ScopeContext,
  config: { scopeColumn?: string | null; scopeSetting?: string | null; tables: string[] }
): Promise<void> {
  if (scope.mode === "NONE" || scope.mode === "SEPARATE_CREDENTIALS") return;

  const value = assertSafeScopeValue(scope.tenantKey || "");

  if (scope.mode === "NATIVE_RLS") {
    const setting = config.scopeSetting;
    if (!setting) {
      throw new ScopeError(
        "This connection uses native row-level security but no session setting " +
          "is configured for the tenant value.",
        "NO_SCOPE_SETTING"
      );
    }
    // Re-validated here, not only where the scope was resolved: applyScope can
    // be reached with a config read straight from the connection row, and a
    // check that only runs on one path is a check that does not run.
    assertSafeIdentifier(setting.replace(".", "_"), "Scope setting");

    if (handle.dialect === "POSTGRESQL") {
      // Inlined, not bound — see the note on assertSafeScopeValue. Both
      // fragments have passed an allow-list, so neither can close the quote.
      await handle.run(`SELECT set_config('${setting}', '${value}', false)`);
      return;
    }
    if (handle.dialect === "MYSQL" || handle.dialect === "MARIADB") {
      await handle.run(`SET @${setting.replace(/\W/g, "_")} = '${value}'`);
      return;
    }
    throw new ScopeError(
      `${handle.dialect} has no session settings for row-level security.`,
      "MODE_UNSUPPORTED"
    );
  }

  /* MANAGED_VIEWS */
  const column = config.scopeColumn;
  if (!column) {
    throw new ScopeError(
      "This connection uses managed views but no tenant column is configured.",
      "NO_SCOPE_COLUMN"
    );
  }
  assertSafeIdentifier(column, "Scope column");
  if (config.tables.length === 0) {
    throw new ScopeError(
      "This connection is scoped but exposes no tables.",
      "NO_SCOPED_TABLES"
    );
  }
  for (const table of config.tables) {
    assertSafeIdentifier(table, "Scoped table");
    const view = scopedViewName(table);
    // Every fragment here has been through an allow-list: the table and column
    // are validated identifiers, the value is a validated scope key. Nothing
    // reaches this string unchecked.
    await handle.run(
      `CREATE TEMP VIEW ${view} AS SELECT * FROM ${table} WHERE ${column} = '${value}'`
    );
  }
}

/**
 * Open a connection that is already scoped, or throw.
 *
 * There is deliberately no way to get a half-scoped handle: if applying the
 * scope fails the handle is closed and the error propagates.
 */
export async function openScopedConnection(
  scope: ScopeContext,
  config: { scopeColumn?: string | null; scopeSetting?: string | null; tables: string[] }
): Promise<DbHandle> {
  const handle = await openConnection(scope.credentials);
  try {
    await applyScope(handle, scope, config);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** The configuration `applyScope` needs, read from the connection row. */
export async function scopeConfigFor(connectionId: string) {
  const conn = await prisma.databaseConnection.findUnique({
    where: { id: connectionId },
    select: { scopeColumn: true, scopeSetting: true, scopedTables: true },
  });
  return {
    scopeColumn: conn?.scopeColumn ?? null,
    scopeSetting: conn?.scopeSetting ?? null,
    tables: parseTables(conn?.scopedTables),
  };
}

export { parseTables };
