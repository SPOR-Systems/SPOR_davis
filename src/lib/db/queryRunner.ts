import {
  DbHandle,
  Dialect,
  dialectLabel,
  getDbCredentials,
  openConnection,
  withConnection,
} from "@/lib/db/connection";

export {
  buildSchemaContext,
  getSchemaContext,
  renderSchemaForPrompt,
  introspectSchema,
} from "@/lib/db/schemaContext";
export type { SchemaContext } from "@/lib/db/schemaContext";
export { dialectLabel };

export const MAX_ROWS = Number(process.env.DAVIS_MAX_ROWS || 1000);

export interface QueryResult {
  columns: string[];
  rows: any[];
  /** Rows actually returned (after the safety cap). */
  rowCount: number;
  /** True when the result hit MAX_ROWS and more rows exist. */
  truncated: boolean;
  /** The SQL that was really executed, after the LIMIT guard. */
  executedSql?: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Read-only enforcement                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Strip comments and string literals so keyword scanning cannot be fooled by
 * a legitimate value like  WHERE CHIEF_COMPLAINT_TXT LIKE '%update%'.
 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, ' "" ');
}

const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "replace",
  "merge",
  "grant",
  "revoke",
  "attach",
  "detach",
  "vacuum",
  "reindex",
  "pragma",
  "call",
  "execute",
  "exec",
  "copy",
  "into",
  "lock",
  "commit",
  "rollback",
  "savepoint",
];

export interface GuardResult {
  ok: boolean;
  error?: string;
  sql: string;
}

/**
 * Verifies a statement is a single read-only query and appends a hard row cap.
 * The previous implementation only checked that the string started with SELECT,
 * which let stacked statements and CTE-wrapped writes through.
 */
export function guardQuery(rawSql: string, dialect: Dialect): GuardResult {
  let sql = (rawSql || "").trim();

  // Strip a trailing semicolon (and any trailing whitespace/comments).
  sql = sql.replace(/;\s*$/, "").trim();

  if (!sql) {
    return { ok: false, error: "Empty query.", sql };
  }

  const scrubbed = stripLiteralsAndComments(sql);

  // Reject stacked statements.
  if (/;/.test(scrubbed)) {
    return {
      ok: false,
      error: "Only a single SQL statement is permitted.",
      sql,
    };
  }

  const head = scrubbed.trim().toUpperCase();
  if (!head.startsWith("SELECT") && !head.startsWith("WITH")) {
    return {
      ok: false,
      error: "Only SELECT (or WITH ... SELECT) queries are permitted.",
      sql,
    };
  }

  for (const kw of FORBIDDEN) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(scrubbed)) {
      return {
        ok: false,
        error: `Query rejected: the keyword "${kw.toUpperCase()}" is not permitted in a read-only query.`,
        sql,
      };
    }
  }

  // Append a row cap when the model did not supply one, so a runaway query
  // cannot pull a million rows into memory. We ask for MAX_ROWS + 1 so we can
  // detect truncation.
  const hasLimit = /\blimit\b|\bfetch\s+first\b/i.test(scrubbed);
  const executedSql = hasLimit ? sql : `${sql}\nLIMIT ${MAX_ROWS + 1}`;

  return { ok: true, sql: executedSql };
}

/* -------------------------------------------------------------------------- */
/* Dry-run validation                                                         */
/* -------------------------------------------------------------------------- */

function explainPrefix(dialect: Dialect): string {
  if (dialect === "SQLITE") return "EXPLAIN QUERY PLAN ";
  return "EXPLAIN ";
}

/**
 * Ask the engine to plan the query without running it. This catches
 * hallucinated tables/columns and syntax errors in milliseconds, so the
 * self-correction loop can fix them before we pay for a real execution.
 */
export async function validateQuery(
  connectionId: string,
  orgId: string,
  sql: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    return await withConnection(connectionId, orgId, async (handle) => {
      const dialect = handle.dialect;
      const guard = guardQuery(sql, dialect);
      if (!guard.ok) return { valid: false, error: guard.error };

      try {
        await handle.run(explainPrefix(dialect) + guard.sql);
        return { valid: true };
      } catch (err: any) {
        return { valid: false, error: err?.message || String(err) };
      }
    });
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/** Execute a read-only query with validation, row cap and timeout. */
export async function executeQuery(
  connectionId: string,
  orgId: string,
  query: string
): Promise<QueryResult> {
  const empty = { columns: [], rows: [], rowCount: 0, truncated: false };

  let credentials;
  try {
    credentials = await getDbCredentials(connectionId, orgId);
  } catch (err: any) {
    return { ...empty, error: err?.message || String(err) };
  }

  const dialect = credentials.type.toUpperCase() as Dialect;
  const guard = guardQuery(query, dialect);
  if (!guard.ok) {
    return { ...empty, error: `Security Error: ${guard.error}` };
  }

  let handle: DbHandle;
  try {
    handle = await openConnection(credentials);
  } catch (err: any) {
    return { ...empty, error: `Connection failed: ${err?.message || err}` };
  }

  try {
    const res = await handle.run(guard.sql);
    const truncated = res.rows.length > MAX_ROWS;
    const rows = truncated ? res.rows.slice(0, MAX_ROWS) : res.rows;

    return {
      columns: res.columns.length
        ? res.columns
        : rows.length
        ? Object.keys(rows[0])
        : [],
      rows,
      rowCount: rows.length,
      truncated,
      executedSql: guard.sql,
    };
  } catch (err: any) {
    return {
      ...empty,
      executedSql: guard.sql,
      error: err?.message || String(err),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Runs a COUNT(*) over the model's query so we can report the true total even
 * when the row cap kicked in. Used only when the result was truncated.
 */
export async function countRows(
  connectionId: string,
  orgId: string,
  sql: string
): Promise<number | null> {
  const cleaned = sql.replace(/;\s*$/, "").trim();
  try {
    return await withConnection(connectionId, orgId, async (handle) => {
      const res = await handle.run(
        `SELECT COUNT(*) AS _n FROM (${cleaned}) AS _davis_count`
      );
      const n = res.rows[0]?._n ?? res.rows[0]?.["COUNT(*)"];
      return n === undefined ? null : Number(n);
    });
  } catch {
    return null;
  }
}
