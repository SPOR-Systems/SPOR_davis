import { prisma } from "@/lib/prisma";
import { openConnection, type DbHandle, type Dialect } from "@/lib/db/connection";
import { guardQuery } from "@/lib/db/queryRunner";
import {
  ScopeError,
  resolveScope,
  openScopedConnection,
  scopeConfigFor,
  scopedViewName,
  assertSafeScopeValue,
  assertSafeIdentifier,
  type ScopeContext,
} from "@/lib/db/scope";

/**
 * ============================================================================
 *  ISOLATION CHECK
 * ============================================================================
 *  A scoped connection that does not actually isolate is worse than an
 *  unscoped one, because everybody involved believes it is safe. Misconfigured
 *  scoping fails OPEN: the views get built, the queries run, the numbers look
 *  plausible, and nobody finds out until one tenant reads another's data.
 *
 *  So a scoped connection does not answer questions until it has PROVEN it
 *  isolates. `resolveScope` refuses any connection whose `verifiedAt` is null,
 *  and this module is the only thing that sets it.
 *
 *  WHAT COUNTS AS PROOF
 *  --------------------
 *  Not "the configuration looks right". Two tenants are opened side by side and
 *  asked to read the same objects, and the check demands evidence that they saw
 *  DIFFERENT ROWS. Everything that cannot be demonstrated is reported as not
 *  demonstrated; the connection stays unverified.
 *
 *  A single tenant cannot prove isolation — there is nothing to be isolated
 *  from. So can a check that only counts rows: two clinics with 100 patients
 *  each produce identical counts. The load-bearing check is the direct one —
 *  through tenant A's connection, ask for rows belonging to tenant B and
 *  require zero.
 *
 *  WHAT THIS CANNOT PROVE
 *  ----------------------
 *  It verifies that the CONFIGURED column filters consistently. It cannot know
 *  the configured column is the RIGHT column. If an integrator points DAVIS at
 *  a column that happens to partition the table but does not mean "tenant" —
 *  a region code, a legacy site id that was reused — every check here passes
 *  and the data is still wrong. Only the integrator knows which column carries
 *  their customer boundary, so the configuration screen has to say so plainly;
 *  no probe can recover that.
 *
 *  Note also that under MANAGED_VIEWS the leak probe is a backstop rather than
 *  the primary net: the view's own WHERE clause makes a foreign row impossible
 *  by construction, so what actually catches a bad column there is the vacuity
 *  check — "no table held rows for both tenants, so nothing was demonstrated".
 *  The probe earns its place under NATIVE_RLS, where the predicate lives in a
 *  policy DAVIS did not write and cannot read.
 * ============================================================================
 */

export interface ScopeCheck {
  name: string;
  /** false is a failure; null is "could not be demonstrated here". */
  passed: boolean | null;
  detail: string;
}

export interface ScopeVerification {
  verified: boolean;
  mode: string;
  tenantA?: string;
  tenantB?: string;
  checks: ScopeCheck[];
  /** One line, stored on the connection and shown in the UI. */
  note: string;
}

function quote(dialect: Dialect, name: string): string {
  if (dialect === "MYSQL" || dialect === "MARIADB") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

async function countOf(handle: DbHandle, sql: string): Promise<number | null> {
  try {
    const res = await handle.run(sql);
    const row: any = res.rows[0] || {};
    const value = row._n ?? Object.values(row)[0];
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Prove — or fail to prove — that this connection isolates its tenants.
 *
 * Writes `verifiedAt` only on a clean pass. Everything else clears it, so a
 * connection that used to verify and no longer does stops answering rather
 * than coasting on an old result.
 */
export async function verifyScope(
  connectionId: string,
  organizationId: string
): Promise<ScopeVerification> {
  const checks: ScopeCheck[] = [];
  const fail = async (
    mode: string,
    note: string,
    extra?: ScopeCheck
  ): Promise<ScopeVerification> => {
    if (extra) checks.push(extra);
    await prisma.databaseConnection.update({
      where: { id: connectionId },
      data: { verifiedAt: null, verifyNote: note },
    });
    return { verified: false, mode, checks, note };
  };

  const conn = await prisma.databaseConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!conn) throw new ScopeError("Database connection not found.", "NO_CONNECTION");

  const mode = conn.scopeMode || "NONE";
  const dialect = conn.type.toUpperCase() as Dialect;

  if (mode === "NONE") {
    return {
      verified: false,
      mode,
      checks: [
        {
          name: "Scoping configured",
          passed: null,
          detail:
            "No separation is set up, so there is nothing to test. This connection " +
            "can serve your own team but not your customers.",
        },
      ],
      note: "No separation set up — nothing to test.",
    };
  }

  /* ---- Two tenants, or no proof ---------------------------------------- */
  const tenants = await prisma.tenant.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      OR: [{ connectionId: conn.id }, { connectionId: null }],
    },
    orderBy: { createdAt: "asc" },
    take: 2,
  });

  if (tenants.length < 2) {
    return fail(
      mode,
      `Isolation cannot be demonstrated with ${tenants.length} tenant${
        tenants.length === 1 ? "" : "s"
      }. Add a second tenant with data of its own, then test again.`,
      {
        name: "Two tenants to compare",
        passed: false,
        detail: `Found ${tenants.length}. The test compares what two tenants can see.`,
      }
    );
  }

  const [a, b] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
  checks.push({
    name: "Two tenants available",
    passed: true,
    detail: `Comparing "${a.externalKey}" against "${b.externalKey}".`,
  });

  const config = await scopeConfigFor(conn.id);
  if (config.tables.length === 0) {
    return fail(mode, "No tables are listed, so this connection can answer nothing.", {
      name: "Tables listed",
      passed: false,
      detail: "Add at least one table DAVIS is allowed to read.",
    });
  }

  let scopeA: ScopeContext;
  let scopeB: ScopeContext;
  try {
    scopeA = await resolveScope({
      connectionId: conn.id,
      organizationId,
      tenantKey: a.externalKey,
      forVerification: true,
    });
    scopeB = await resolveScope({
      connectionId: conn.id,
      organizationId,
      tenantKey: b.externalKey,
      forVerification: true,
    });
  } catch (err: any) {
    return fail(mode, `Scope could not be resolved: ${err?.message || err}`, {
      name: "Scope resolves",
      passed: false,
      detail: String(err?.message || err),
    });
  }
  checks.push({
    name: "Scope resolves",
    passed: true,
    detail: `Both tenants resolve in ${mode} mode over ${config.tables.length} table(s).`,
  });

  /* ---- Layer 2 refuses the base tables --------------------------------- */
  // A pure check of the object allow-list, not of the database. Worth recording
  // because it is the layer that catches a query naming something unexposed.
  if (mode === "MANAGED_VIEWS") {
    const offenders = config.tables.filter(
      (t) => guardQuery(`SELECT * FROM ${t}`, dialect, scopeA.allowedObjects).ok
    );
    if (offenders.length > 0) {
      return fail(
        mode,
        `The query guard would allow a base table (${offenders[0]}) to be read directly.`,
        {
          name: "Base tables refused by the guard",
          passed: false,
          detail: `Allowed: ${offenders.join(", ")}.`,
        }
      );
    }
    checks.push({
      name: "Base tables refused by the guard",
      passed: true,
      detail: `Only the ${scopeA.allowedObjects.length} scoped view(s) may be named.`,
    });
  }

  /* ---- Different credentials, for the credential-based mode ------------ */
  if (mode === "SEPARATE_CREDENTIALS") {
    const same =
      scopeA.credentials.database === scopeB.credentials.database &&
      scopeA.credentials.username === scopeB.credentials.username &&
      scopeA.credentials.host === scopeB.credentials.host;
    if (same) {
      return fail(
        mode,
        "Both tenants resolve to the same database and user, so the credentials " +
          "isolate nothing.",
        {
          name: "Credentials differ per tenant",
          passed: false,
          detail: `Both resolve to ${scopeA.credentials.username}@${scopeA.credentials.host}/${scopeA.credentials.database}.`,
        }
      );
    }
    checks.push({
      name: "Credentials differ per tenant",
      passed: true,
      detail: "The two tenants open different databases or users.",
    });
  }

  /* ---- The load-bearing probe ------------------------------------------ */
  let handleA: DbHandle | null = null;
  let handleB: DbHandle | null = null;
  let unscoped: DbHandle | null = null;

  try {
    try {
      handleA = await openScopedConnection(scopeA, config);
      handleB = await openScopedConnection(scopeB, config);
    } catch (err: any) {
      return fail(mode, `A scoped connection could not be opened: ${err?.message || err}`, {
        name: "Scoped connection opens",
        passed: false,
        detail: String(err?.message || err),
      });
    }
    checks.push({
      name: "Scoped connection opens",
      passed: true,
      detail: "Both tenants' scoped surfaces were built successfully.",
    });

    const keyA = assertSafeScopeValue(scopeA.tenantKey || "");
    const keyB = assertSafeScopeValue(scopeB.tenantKey || "");
    const column = conn.scopeColumn
      ? assertSafeIdentifier(conn.scopeColumn, "Scope column")
      : null;

    let strongEvidence = 0;

    for (const base of config.tables) {
      const object = mode === "MANAGED_VIEWS" ? scopedViewName(base) : base;
      const objSql = quote(dialect, object);

      const nA = await countOf(handleA, `SELECT COUNT(*) AS _n FROM ${objSql}`);
      const nB = await countOf(handleB, `SELECT COUNT(*) AS _n FROM ${objSql}`);

      if (column) {
        // The direct question: through A's connection, how many of B's rows are
        // visible? Any answer other than zero is a leak, and an answer of
        // "query failed" is not an answer.
        const colSql = quote(dialect, column);
        const leakA = await countOf(
          handleA,
          `SELECT COUNT(*) AS _n FROM ${objSql} WHERE ${colSql} = '${keyB}'`
        );
        const leakB = await countOf(
          handleB,
          `SELECT COUNT(*) AS _n FROM ${objSql} WHERE ${colSql} = '${keyA}'`
        );

        if (leakA === null || leakB === null) {
          return fail(
            mode,
            `The leak probe could not be run against ${object} — the tenant column ` +
              `${column} may not exist there.`,
            {
              name: `${object}: cross-tenant rows invisible`,
              passed: false,
              detail: "The probe query failed, so nothing was established.",
            }
          );
        }
        if (leakA > 0 || leakB > 0) {
          return fail(
            mode,
            `LEAK: ${object} exposes rows belonging to another tenant.`,
            {
              name: `${object}: cross-tenant rows invisible`,
              passed: false,
              detail:
                `"${keyA}" can see ${leakA} row(s) belonging to "${keyB}"; ` +
                `"${keyB}" can see ${leakB} row(s) belonging to "${keyA}".`,
            }
          );
        }

        // Also require the filter to be the ONLY thing standing there: every
        // row A can see must carry A's key.
        const foreign = await countOf(
          handleA,
          `SELECT COUNT(*) AS _n FROM ${objSql} WHERE ${colSql} <> '${keyA}' OR ${colSql} IS NULL`
        );
        if (foreign === null || foreign > 0) {
          return fail(
            mode,
            `${object} returns rows that do not belong to the requesting tenant.`,
            {
              name: `${object}: every visible row belongs to the tenant`,
              passed: false,
              detail:
                foreign === null
                  ? "The probe query failed."
                  : `${foreign} row(s) carry another key or none at all.`,
            }
          );
        }

        checks.push({
          name: `${object}: rows are the tenant's own`,
          passed: true,
          detail:
            `"${keyA}" sees ${nA ?? "?"} row(s), "${keyB}" sees ${nB ?? "?"}, ` +
            `and neither can see any of the other's.`,
        });
        if ((nA ?? 0) > 0 && (nB ?? 0) > 0) strongEvidence++;
        continue;
      }

      /* No tenant column — the credentials are the boundary. Then the only
         available evidence is that the two surfaces are not the same data. */
      if (nA === null || nB === null) {
        return fail(mode, `${object} could not be read through both tenants.`, {
          name: `${object}: readable by both tenants`,
          passed: false,
          detail: "One of the two counts failed.",
        });
      }
      checks.push({
        name: `${object}: separate data`,
        passed: nA !== nB ? true : null,
        detail:
          nA !== nB
            ? `Different row counts (${nA} vs ${nB}), so the two connections are not the same data.`
            : `Both see ${nA} row(s). Equal counts prove nothing either way.`,
      });
      if (nA !== nB && nA > 0 && nB > 0) strongEvidence++;
    }

    /* ---- Is anything left unscoped? ----------------------------------- */
    // For MANAGED_VIEWS, compare against the unscoped total. A view returning
    // every row is the classic symptom of a scope column that does not
    // discriminate — a column whose value is the same for everyone.
    if (mode === "MANAGED_VIEWS") {
      unscoped = await openConnection(scopeA.credentials);
      for (const base of config.tables) {
        const total = await countOf(
          unscoped,
          `SELECT COUNT(*) AS _n FROM ${quote(dialect, base)}`
        );
        const scoped = await countOf(
          handleA,
          `SELECT COUNT(*) AS _n FROM ${quote(dialect, scopedViewName(base))}`
        );
        if (total !== null && scoped !== null && total > 0 && scoped === total) {
          return fail(
            mode,
            `The scoped view over ${base} returns every row in the table, so the ` +
              `tenant column ${conn.scopeColumn} does not distinguish tenants.`,
            {
              name: `${base}: view narrows the table`,
              passed: false,
              detail: `${scoped} of ${total} rows visible to a single tenant.`,
            }
          );
        }
      }
      checks.push({
        name: "Views narrow their tables",
        passed: true,
        detail: "No scoped view returns its whole base table.",
      });
    }

    /* ---- Verdict ------------------------------------------------------- */
    if (strongEvidence === 0) {
      return fail(
        mode,
        "The settings look right, but no table held data for two different " +
          "tenants, so nothing was actually proven. Add some data for a second " +
          "tenant and test again.",
        {
          name: "Tested against real data",
          passed: false,
          detail: "One or both tenants had no rows, so there was nothing to compare.",
        }
      );
    }

    const note =
      `Passed: ${strongEvidence} table(s) held data for both tenants, and neither ` +
      `could see the other's rows.`;
    checks.push({
      name: "Tested against real data",
      passed: true,
      detail: `${strongEvidence} table(s) had rows for both tenants.`,
    });
    await prisma.databaseConnection.update({
      where: { id: connectionId },
      data: { verifiedAt: new Date(), verifyNote: note },
    });
    return { verified: true, mode, tenantA: a.externalKey, tenantB: b.externalKey, checks, note };
  } finally {
    await handleA?.close().catch(() => {});
    await handleB?.close().catch(() => {});
    await unscoped?.close().catch(() => {});
  }
}
