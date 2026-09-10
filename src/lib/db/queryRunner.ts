import {
  DbHandle,
  Dialect,
  dialectLabel,
  openConnection,
} from "@/lib/db/connection";
import {
  openScopedConnection,
  resolveScope,
  scopeConfigFor,
  type ScopeContext,
} from "@/lib/db/scope";

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
export function guardQuery(
  rawSql: string,
  dialect: Dialect,
  /**
   * When present and non-empty, the complete set of objects the query may name.
   * Comes from the resolved scope; an empty list means the connection is
   * unscoped and this layer does not apply.
   */
  allowedObjects?: string[] | null
): GuardResult {
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

  /* ---- Object allow-list (scoped connections only) --------------------- */
  if (allowedObjects && allowedObjects.length > 0) {
    const scan = referencedObjects(sql);
    if (!scan.ok) {
      return { ok: false, error: scan.error, sql };
    }
    if (scan.objects.length === 0) {
      return {
        ok: false,
        error:
          "Query rejected: this connection restricts which tables may be read, " +
          "and the query names none of them.",
        sql,
      };
    }
    const offending = scan.objects.filter((o) => !objectIsAllowed(o, allowedObjects));
    if (offending.length > 0) {
      return {
        ok: false,
        error:
          `Query rejected: ${offending.map((o) => `"${o}"`).join(", ")} ` +
          `${offending.length === 1 ? "is not" : "are not"} readable on this ` +
          `connection. Readable: ${allowedObjects.join(", ")}.`,
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
/* Object allow-list                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Layer 2 of scoping: when a connection is scoped, the query may only name
 * objects that were declared for that tenant.
 *
 * This layer REJECTS; it never rewrites. Rewriting a query to add a tenant
 * predicate needs a full per-dialect parser and every bug in it is a leak.
 * Deciding whether a name is on a list needs only to find the names, and the
 * failure mode of "I could not confidently find them" is a refusal.
 *
 * So everything below is written to fail closed. Anything the scan cannot
 * resolve — a bracket-quoted name, a table-valued function, a CTE list it
 * could not parse — is an error, not a shrug.
 */

/** Comments and single-quoted literals go; quoted identifiers stay. */
function stripForIdentifiers(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ");
}

/**
 * Functions whose argument list contains the word FROM without it introducing
 * a table: EXTRACT(YEAR FROM d), SUBSTRING(s FROM 1 FOR 2), TRIM(BOTH ' ' FROM s).
 * Missing these would refuse ordinary date queries.
 */
const FROM_IS_NOT_A_TABLE = new Set([
  "extract",
  "substring",
  "trim",
  "overlay",
  "position",
]);

/** Words that end a table reference list. */
const REF_STOP = new Set([
  "where", "group", "order", "having", "limit", "offset", "fetch", "window",
  "union", "intersect", "except", "on", "using", "join", "straight_join",
  "inner", "left", "right", "full", "cross", "natural", "outer", "for",
  "qualify", "returning", "with", "select", "from", "and", "or", "when",
  "then", "else", "end",
]);
// "as" is deliberately absent: it precedes an alias, and stopping there would
// lose the rest of a comma-separated list ("FROM a AS x, b").

/** Words that may sit between FROM and the table name. */
const REF_PREFIX = new Set(["only", "lateral"]);

const BARE_WORD = /^[A-Za-z_][A-Za-z0-9_$]*/;

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

function readWord(s: string, i: number): { word: string; next: number } {
  const m = BARE_WORD.exec(s.slice(i));
  return m ? { word: m[0], next: i + m[0].length } : { word: "", next: i };
}

/** One dot-separated part: bare, "quoted" or `backticked`. */
function readNamePart(s: string, i: number): { part: string | null; next: number } {
  i = skipSpace(s, i);
  const ch = s[i];
  if (ch === '"' || ch === "`") {
    let j = i + 1;
    let out = "";
    while (j < s.length) {
      if (s[j] === ch) {
        if (s[j + 1] === ch) {
          out += ch;
          j += 2;
          continue;
        }
        return { part: out, next: j + 1 };
      }
      out += s[j++];
    }
    return { part: null, next: i }; // unterminated
  }
  const { word, next } = readWord(s, i);
  return word ? { part: word, next } : { part: null, next: i };
}

/** Skip a parenthesised group, returning the index just past its close. */
function skipBalanced(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

class ScanError extends Error {}

/**
 * Collect every object a query reads, minus the CTEs it defines.
 *
 * `inherited` carries CTE names down into subqueries, which can see them.
 */
function scanRefs(text: string, out: Set<string>, inherited: Set<string>): void {
  const s = text;
  const ctes = new Set(inherited);

  /* ---- The leading WITH list, parsed strictly -------------------------- */
  // Loosely matching "name AS (" anywhere would let a mis-read alias erase a
  // real table from the check, so this walks the list or gives up.
  {
    let i = skipSpace(s, 0);
    const head = readWord(s, i);
    if (head.word.toLowerCase() === "with") {
      i = skipSpace(s, head.next);
      const rec = readWord(s, i);
      if (rec.word.toLowerCase() === "recursive") i = skipSpace(s, rec.next);
      for (;;) {
        const name = readWord(s, i);
        if (!name.word) throw new ScanError("a WITH clause without a name");
        ctes.add(name.word.toLowerCase());
        i = skipSpace(s, name.next);
        if (s[i] === "(") {
          // Optional column list.
          const past = skipBalanced(s, i);
          if (past < 0) throw new ScanError("an unclosed bracket in a WITH clause");
          i = skipSpace(s, past);
        }
        const as = readWord(s, i);
        if (as.word.toLowerCase() !== "as") {
          throw new ScanError("a WITH clause this check could not read");
        }
        i = skipSpace(s, as.next);
        let mat = readWord(s, i);
        if (mat.word.toLowerCase() === "not") {
          i = skipSpace(s, mat.next);
          mat = readWord(s, i);
        }
        if (mat.word.toLowerCase() === "materialized") i = skipSpace(s, mat.next);
        if (s[i] !== "(") throw new ScanError("a WITH clause this check could not read");
        const past = skipBalanced(s, i);
        if (past < 0) throw new ScanError("an unclosed bracket in a WITH clause");
        i = skipSpace(s, past);
        if (s[i] === ",") {
          i = skipSpace(s, i + 1);
          continue;
        }
        break;
      }
    }
  }

  /* ---- One table reference -------------------------------------------- */
  // Returns the index to resume from. Subqueries are scanned recursively so a
  // derived table cannot hide a base table inside itself.
  const parseRef = (start: number): number => {
    let i = skipSpace(s, start);

    for (;;) {
      const w = readWord(s, i);
      if (w.word && REF_PREFIX.has(w.word.toLowerCase())) {
        i = skipSpace(s, w.next);
        continue;
      }
      break;
    }

    if (s[i] === "(") {
      const past = skipBalanced(s, i);
      if (past < 0) throw new ScanError("an unclosed bracket");
      scanRefs(s.slice(i + 1, past - 1), out, ctes);
      return past;
    }

    const parts: string[] = [];
    for (;;) {
      const p = readNamePart(s, i);
      if (p.part === null) {
        throw new ScanError("a table name this check could not read");
      }
      parts.push(p.part);
      const j = skipSpace(s, p.next);
      if (s[j] === ".") {
        i = j + 1;
        continue;
      }
      i = p.next;
      break;
    }

    const first = parts[0]!.toLowerCase();
    if (REF_STOP.has(first) && parts.length === 1) {
      throw new ScanError(`"${parts[0]}" where a table name was expected`);
    }

    // An identifier followed by "(" is a table-valued function, not a table.
    if (s[skipSpace(s, i)] === "(") {
      throw new ScanError(`the function ${parts.join(".")}() used as a table`);
    }

    const name = parts.join(".");
    if (!ctes.has(name.toLowerCase())) out.add(name);
    return i;
  };

  /* ---- Linear scan ----------------------------------------------------- */
  const stack: string[] = [];
  let lastWord = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "(") {
      stack.push(lastWord.toLowerCase());
      lastWord = "";
      i++;
      continue;
    }
    if (ch === ")") {
      stack.pop();
      lastWord = "";
      i++;
      continue;
    }

    if (ch === '"' || ch === "`") {
      const p = readNamePart(s, i);
      if (p.part === null) throw new ScanError("an unterminated quoted name");
      lastWord = p.part;
      i = p.next;
      continue;
    }

    if (ch === "[") {
      // Bracket quoting is not one of DAVIS's dialects, and guessing at it here
      // would be guessing about what the query reads.
      throw new ScanError("a bracket-quoted name");
    }

    const w = readWord(s, i);
    if (w.word) {
      const lower = w.word.toLowerCase();

      if (lower === "from" && FROM_IS_NOT_A_TABLE.has(stack[stack.length - 1] || "")) {
        lastWord = lower;
        i = w.next;
        continue;
      }

      // MySQL's STRAIGHT_JOIN is one word, so a \\bjoin\\b match never sees it.
      if (lower === "from" || lower === "join" || lower === "straight_join") {
        let j = parseRef(w.next);
        if (lower === "from") {
          // FROM a, b, c — a naive scan that took only the first name here
          // would be a hole big enough to drive a table through.
          for (;;) {
            const k = skipSpace(s, j);
            if (s[k] === ",") {
              j = parseRef(k + 1);
              continue;
            }
            const nw = readWord(s, k);
            if (nw.word && !REF_STOP.has(nw.word.toLowerCase())) {
              // An alias. Step over it and look again for a comma.
              j = nw.next;
              continue;
            }
            break;
          }
        }
        lastWord = "";
        i = j;
        continue;
      }

      lastWord = w.word;
      i = w.next;
      continue;
    }

    lastWord = "";
    i++;
  }
}

/**
 * Every object the statement reads, or an error if that cannot be established.
 */
export function referencedObjects(
  sql: string
): { ok: true; objects: string[] } | { ok: false; error: string } {
  const out = new Set<string>();
  try {
    scanRefs(stripForIdentifiers(sql), out, new Set());
  } catch (err: any) {
    const detail = err instanceof ScanError ? err.message : "an unexpected shape";
    return {
      ok: false,
      error:
        `Query rejected: this connection restricts which tables may be read, and ` +
        `the query contains ${detail}, so the check could not establish what it reads.`,
    };
  }
  return { ok: true, objects: [...out] };
}

/** Case-insensitive membership, tolerating an unqualified use of a declared name. */
function objectIsAllowed(obj: string, allowed: string[]): boolean {
  const o = obj.toLowerCase();
  for (const entry of allowed) {
    const a = entry.toLowerCase();
    if (o === a) return true;
    if (a.includes(".") && !o.includes(".") && a.split(".").pop() === o) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Where a query runs                                                        */
/* -------------------------------------------------------------------------- */

export interface ScopeApplyConfig {
  scopeColumn?: string | null;
  scopeSetting?: string | null;
  tables: string[];
}

/**
 * A connection plus the scope a query will run under.
 *
 * This is a required argument on every function that touches the customer
 * database, and that is the whole design. The previous signatures took
 * `(connectionId, orgId, sql)`, which meant an unscoped query was what you got
 * by not thinking about it — and a new call site added six months from now
 * would compile, run, and quietly read every tenant's rows. Now it does not
 * compile until someone has said which tenant is asking.
 */
export interface QueryTarget {
  connectionId: string;
  organizationId: string;
  scope: ScopeContext;
  config: ScopeApplyConfig;
}

export async function resolveQueryTarget(args: {
  connectionId: string;
  organizationId: string;
  /** The integrator's tenant key. Absent means an unscoped (standalone) request. */
  tenantKey?: string | null;
  /** True for embedded requests, which may never run against a NONE connection. */
  requireScope?: boolean;
}): Promise<QueryTarget> {
  const scope = await resolveScope(args);
  const config =
    scope.mode === "NONE"
      ? { scopeColumn: null, scopeSetting: null, tables: [] }
      : await scopeConfigFor(args.connectionId);
  return {
    connectionId: args.connectionId,
    organizationId: args.organizationId,
    scope,
    config,
  };
}

function dialectOf(target: QueryTarget): Dialect {
  return target.scope.credentials.type.toUpperCase() as Dialect;
}

/** Guard a statement against this target's allow-list. */
function guardFor(target: QueryTarget, sql: string): GuardResult {
  return guardQuery(
    sql,
    dialectOf(target),
    target.scope.mode === "NONE" ? null : target.scope.allowedObjects
  );
}

/** Open a handle that can only see what this target is allowed to see. */
async function openFor(target: QueryTarget): Promise<DbHandle> {
  return target.scope.mode === "NONE"
    ? openConnection(target.scope.credentials)
    : openScopedConnection(target.scope, target.config);
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
 *
 * On a scoped target the plan runs against the scoped surface, so a query
 * naming a table the tenant cannot see fails here — with a message the repair
 * loop can act on — rather than at execution.
 */
export async function validateQuery(
  target: QueryTarget,
  sql: string
): Promise<{ valid: boolean; error?: string }> {
  const guard = guardFor(target, sql);
  if (!guard.ok) return { valid: false, error: guard.error };

  let handle: DbHandle;
  try {
    handle = await openFor(target);
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  }
  try {
    await handle.run(explainPrefix(dialectOf(target)) + guard.sql);
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  } finally {
    await handle.close().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/** Execute a read-only query with validation, row cap and timeout. */
export async function executeQuery(
  target: QueryTarget,
  query: string
): Promise<QueryResult> {
  const empty = { columns: [], rows: [], rowCount: 0, truncated: false };

  const guard = guardFor(target, query);
  if (!guard.ok) {
    return { ...empty, error: `Security Error: ${guard.error}` };
  }

  let handle: DbHandle;
  try {
    handle = await openFor(target);
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
    await handle.close().catch(() => {});
  }
}

/**
 * Runs a COUNT(*) over the model's query so we can report the true total even
 * when the row cap kicked in. Used only when the result was truncated.
 *
 * The inner query is guarded before it is wrapped. It used to be wrapped and
 * run as-is, which made this the one path where the model's SQL reached the
 * database without passing the allow-list.
 */
export async function countRows(
  target: QueryTarget,
  sql: string
): Promise<number | null> {
  const guard = guardFor(target, sql);
  if (!guard.ok) return null;
  const inner = guard.sql.replace(/;\s*$/, "").trim();

  let handle: DbHandle;
  try {
    handle = await openFor(target);
  } catch {
    return null;
  }
  try {
    const res = await handle.run(
      `SELECT COUNT(*) AS _n FROM (${inner}) AS _davis_count`
    );
    const n = res.rows[0]?._n ?? res.rows[0]?.["COUNT(*)"];
    return n === undefined ? null : Number(n);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
