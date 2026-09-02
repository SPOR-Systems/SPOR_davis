import { prisma } from "@/lib/prisma";
import {
  DbHandle,
  Dialect,
  dialectLabel,
  getDbCredentials,
  openConnection,
} from "@/lib/db/connection";

/**
 * ============================================================================
 *  RICH SCHEMA CONTEXT
 * ============================================================================
 *  The single biggest cause of wrong answers in a text-to-SQL system is a
 *  starved schema prompt. Names and types alone force the model to *guess*:
 *
 *    - which column joins to which  -> silently wrong numbers
 *    - what a status code looks like -> WHERE CLM_STAT_CD = 'paid' matches 0 rows
 *    - how dates are stored          -> date arithmetic on 'MM/DD/YYYY' strings
 *    - whether values are dirty      -> 'M' vs 'Male' vs '   M' undercounts
 *
 *  So instead of guessing, we measure. This module profiles the live database
 *  and hands the model facts: primary keys, foreign keys, row counts, exact
 *  enumerated values for every low-cardinality column, null counts, min/max
 *  ranges, and detected date formats.
 *
 *  The result is cached on DatabaseConnection.schemaCache.
 * ============================================================================
 */

const MAX_ENUM_DISTINCT = Number(process.env.DAVIS_MAX_ENUM_DISTINCT || 30);
const MAX_TABLES = Number(process.env.DAVIS_MAX_PROFILE_TABLES || 60);
const MAX_COLS_PER_TABLE = Number(process.env.DAVIS_MAX_PROFILE_COLS || 60);
const SCHEMA_CACHE_TTL_MS = Number(
  process.env.DAVIS_SCHEMA_CACHE_TTL_MS || 1000 * 60 * 60 * 6 // 6 hours
);

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  references?: { table: string; column: string };
  /** Total rows where this column IS NULL. */
  nullCount?: number;
  distinctCount?: number;
  /** Exact value list, only when distinctCount <= MAX_ENUM_DISTINCT. */
  enumValues?: { value: string; count: number }[];
  min?: string;
  max?: string;
  /** e.g. ["YYYY-MM-DD (94%)", "MM/DD/YYYY (6%)"] */
  dateFormats?: string[];
  /** Free-text warning, e.g. untrimmed whitespace or mixed casing detected. */
  warnings?: string[];
}

export interface TableMeta {
  name: string;
  rowCount: number;
  columns: ColumnMeta[];
}

export interface ForeignKeyMeta {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface SchemaContext {
  dialect: string;
  database: string;
  tables: TableMeta[];
  foreignKeys: ForeignKeyMeta[];
  generatedAt: string;
  truncated?: string[];
}

/* -------------------------------------------------------------------------- */
/* Identifier quoting                                                         */
/* -------------------------------------------------------------------------- */

function quoteIdent(dialect: Dialect, name: string): string {
  if (dialect === "MYSQL" || dialect === "MARIADB") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

/* -------------------------------------------------------------------------- */
/* Structural introspection (columns, PKs, FKs)                               */
/* -------------------------------------------------------------------------- */

interface RawColumn {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  isPk: boolean;
}

async function introspectPostgres(
  handle: DbHandle
): Promise<{ columns: RawColumn[]; fks: ForeignKeyMeta[] }> {
  const colRes = await handle.run(`
    SELECT
      c.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_pk
    FROM information_schema.columns c
    LEFT JOIN (
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
    ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
    WHERE c.table_schema = 'public'
    ORDER BY c.table_name, c.ordinal_position
  `);

  const fkRes = await handle.run(`
    SELECT
      kcu.table_name  AS from_table,
      kcu.column_name AS from_column,
      ccu.table_name  AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);

  return {
    columns: colRes.rows.map((r: any) => ({
      table: r.table_name,
      column: r.column_name,
      type: r.data_type,
      nullable: String(r.is_nullable).toUpperCase() === "YES",
      isPk: Number(r.is_pk) === 1,
    })),
    fks: fkRes.rows.map((r: any) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
    })),
  };
}

async function introspectMysql(
  handle: DbHandle,
  database: string
): Promise<{ columns: RawColumn[]; fks: ForeignKeyMeta[] }> {
  const esc = database.replace(/'/g, "''");

  const colRes = await handle.run(`
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = '${esc}'
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);

  const fkRes = await handle.run(`
    SELECT TABLE_NAME AS from_table, COLUMN_NAME AS from_column,
           REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = '${esc}' AND REFERENCED_TABLE_NAME IS NOT NULL
  `);

  return {
    columns: colRes.rows.map((r: any) => ({
      table: r.TABLE_NAME,
      column: r.COLUMN_NAME,
      type: r.COLUMN_TYPE,
      nullable: String(r.IS_NULLABLE).toUpperCase() === "YES",
      isPk: String(r.COLUMN_KEY).toUpperCase() === "PRI",
    })),
    fks: fkRes.rows.map((r: any) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
    })),
  };
}

async function introspectSqlite(
  handle: DbHandle
): Promise<{ columns: RawColumn[]; fks: ForeignKeyMeta[] }> {
  const tableRes = await handle.run(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  const columns: RawColumn[] = [];
  const fks: ForeignKeyMeta[] = [];

  // Sequential, not parallel. The original code fired every PRAGMA at once and
  // closed the handle from inside a callback, which raced and could drop tables.
  for (const t of tableRes.rows) {
    const table = t.name;
    const info = await handle.run(`PRAGMA table_info('${table.replace(/'/g, "''")}')`);
    for (const col of info.rows) {
      columns.push({
        table,
        column: col.name,
        type: col.type || "TEXT",
        nullable: Number(col.notnull) === 0,
        isPk: Number(col.pk) > 0,
      });
    }

    const fkInfo = await handle.run(
      `PRAGMA foreign_key_list('${table.replace(/'/g, "''")}')`
    );
    for (const fk of fkInfo.rows) {
      fks.push({
        fromTable: table,
        fromColumn: fk.from,
        toTable: fk.table,
        // A SQLite FK with a null `to` targets the parent's primary key.
        toColumn: fk.to || "rowid",
      });
    }
  }

  return { columns, fks };
}

/* -------------------------------------------------------------------------- */
/* Value profiling                                                            */
/* -------------------------------------------------------------------------- */

function isTextual(type: string): boolean {
  return /char|text|clob|string|enum|uuid|json/i.test(type);
}

function isDateish(name: string, type: string): boolean {
  return (
    /date|time|timestamp/i.test(type) ||
    /(^|_)(DT|DOB|DATE|TM|TS|TIME)(_|$)/i.test(name) ||
    /_dt_tm$|_dt$|_date$/i.test(name)
  );
}

/**
 * Percentages are rendered so a rare-but-present case never reads as absent.
 * A single unparseable date in 5,000 rows still breaks a date filter, so "0%"
 * would be actively misleading here.
 */
function sharePct(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return `${Math.round(p)}%`;
}

const DATE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/, label: "YYYY-MM-DD HH:MM:SS" },
  { re: /^\d{4}-\d{2}-\d{2}$/, label: "YYYY-MM-DD" },
  { re: /^\d{2}\/\d{2}\/\d{4}$/, label: "MM/DD/YYYY" },
  { re: /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, label: "M/D/YY or M/D/YYYY" },
  { re: /^\d{2}-\d{2}-\d{4}$/, label: "DD-MM-YYYY or MM-DD-YYYY" },
  { re: /^\d{8}$/, label: "YYYYMMDD" },
  { re: /^\d{10}$/, label: "unix epoch seconds" },
];

function classifyDateFormats(values: string[]): string[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const raw of values) {
    if (raw === null || raw === undefined) continue;
    const v = String(raw).trim();
    if (!v) continue;
    total++;
    const hit = DATE_PATTERNS.find((p) => p.re.test(v));
    const label = hit ? hit.label : `unrecognised (e.g. "${v.slice(0, 24)}")`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (total === 0) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} (${sharePct(n, total)}, ${n} sampled)`);
}

function detectValueWarnings(values: { value: string; count: number }[]): string[] {
  const warnings: string[] = [];
  const raw = values.map((v) => v.value).filter((v) => v !== null && v !== undefined);

  if (raw.some((v) => typeof v === "string" && v !== v.trim())) {
    warnings.push("contains values with leading/trailing whitespace");
  }

  const lowered = new Map<string, Set<string>>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.trim().toLowerCase();
    if (!lowered.has(key)) lowered.set(key, new Set());
    lowered.get(key)!.add(v);
  }
  if ([...lowered.values()].some((s) => s.size > 1)) {
    warnings.push("same value appears with inconsistent casing/whitespace");
  }

  return warnings;
}

/**
 * One aggregate query per table gives us row count plus, for every profiled
 * column, its null count, distinct count, min and max.
 */
async function profileTable(
  handle: DbHandle,
  dialect: Dialect,
  table: string,
  columns: ColumnMeta[]
): Promise<number> {
  const q = (n: string) => quoteIdent(dialect, n);
  const profiled = columns.slice(0, MAX_COLS_PER_TABLE);

  const selects: string[] = ["COUNT(*) AS _total"];
  profiled.forEach((col, i) => {
    selects.push(`COUNT(${q(col.name)}) AS nn_${i}`);
    selects.push(`COUNT(DISTINCT ${q(col.name)}) AS dc_${i}`);
    selects.push(`MIN(${q(col.name)}) AS mn_${i}`);
    selects.push(`MAX(${q(col.name)}) AS mx_${i}`);
  });

  let total = 0;
  try {
    const res = await handle.run(
      `SELECT ${selects.join(", ")} FROM ${q(table)}`
    );
    const row = res.rows[0] || {};
    total = Number(row._total ?? row.__total ?? 0);

    profiled.forEach((col, i) => {
      const nonNull = Number(row[`nn_${i}`] ?? 0);
      col.nullCount = Math.max(0, total - nonNull);
      col.distinctCount = Number(row[`dc_${i}`] ?? 0);
      const mn = row[`mn_${i}`];
      const mx = row[`mx_${i}`];
      if (mn !== null && mn !== undefined) col.min = String(mn).slice(0, 60);
      if (mx !== null && mx !== undefined) col.max = String(mx).slice(0, 60);
    });
  } catch (err: any) {
    // Fall back to a plain count so the model still knows table size.
    try {
      const res = await handle.run(`SELECT COUNT(*) AS _total FROM ${q(table)}`);
      total = Number(res.rows[0]?._total ?? 0);
    } catch {
      total = 0;
    }
  }

  return total;
}

/**
 * For every column that turned out to be low-cardinality, pull the exact value
 * list with frequencies. This is what stops the model inventing status codes.
 */
async function enumerateValues(
  handle: DbHandle,
  dialect: Dialect,
  table: string,
  col: ColumnMeta
): Promise<void> {
  const q = (n: string) => quoteIdent(dialect, n);
  try {
    const res = await handle.run(`
      SELECT ${q(col.name)} AS v, COUNT(*) AS c
      FROM ${q(table)}
      WHERE ${q(col.name)} IS NOT NULL
      GROUP BY ${q(col.name)}
      ORDER BY c DESC
      LIMIT ${MAX_ENUM_DISTINCT + 1}
    `);
    col.enumValues = res.rows.map((r: any) => ({
      value: r.v === null ? "NULL" : String(r.v),
      count: Number(r.c),
    }));
    const warnings = detectValueWarnings(col.enumValues);
    if (warnings.length) {
      col.warnings = [...(col.warnings || []), ...warnings];
    }
  } catch {
    /* non-fatal */
  }
}

/** Sample a date-ish column so we can tell the model how dates are stored. */
async function profileDateFormats(
  handle: DbHandle,
  dialect: Dialect,
  table: string,
  col: ColumnMeta
): Promise<void> {
  const q = (n: string) => quoteIdent(dialect, n);
  try {
    const res = await handle.run(`
      SELECT ${q(col.name)} AS v
      FROM ${q(table)}
      WHERE ${q(col.name)} IS NOT NULL
      LIMIT 500
    `);
    const formats = classifyDateFormats(res.rows.map((r: any) => r.v));
    if (formats.length) col.dateFormats = formats;
    if (formats.length > 1) {
      col.warnings = [
        ...(col.warnings || []),
        "MIXED DATE FORMATS — parsing must handle every format listed",
      ];
    }
  } catch {
    /* non-fatal */
  }
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

export async function buildSchemaContext(
  connectionId: string,
  orgId: string
): Promise<SchemaContext> {
  const credentials = await getDbCredentials(connectionId, orgId);
  const dialect = credentials.type.toUpperCase() as Dialect;
  const handle = await openConnection(credentials);
  const truncated: string[] = [];

  try {
    let raw: { columns: RawColumn[]; fks: ForeignKeyMeta[] };
    if (dialect === "POSTGRESQL") {
      raw = await introspectPostgres(handle);
    } else if (dialect === "MYSQL" || dialect === "MARIADB") {
      raw = await introspectMysql(handle, credentials.database);
    } else if (dialect === "SQLITE") {
      raw = await introspectSqlite(handle);
    } else {
      throw new Error(`Schema introspection not supported for ${credentials.type}`);
    }

    // Group columns into tables and attach FK targets.
    const fkIndex = new Map<string, ForeignKeyMeta>();
    for (const fk of raw.fks) {
      fkIndex.set(`${fk.fromTable}.${fk.fromColumn}`, fk);
    }

    const tableMap = new Map<string, TableMeta>();
    for (const c of raw.columns) {
      if (!tableMap.has(c.table)) {
        tableMap.set(c.table, { name: c.table, rowCount: 0, columns: [] });
      }
      const fk = fkIndex.get(`${c.table}.${c.column}`);
      tableMap.get(c.table)!.columns.push({
        name: c.column,
        type: c.type,
        nullable: c.nullable,
        isPrimaryKey: c.isPk,
        references: fk ? { table: fk.toTable, column: fk.toColumn } : undefined,
      });
    }

    let tables = [...tableMap.values()];
    if (tables.length > MAX_TABLES) {
      truncated.push(
        `Only the first ${MAX_TABLES} of ${tables.length} tables were profiled.`
      );
      tables = tables.slice(0, MAX_TABLES);
    }

    // Profile each table: counts, ranges, enumerated values, date formats.
    for (const table of tables) {
      table.rowCount = await profileTable(handle, dialect, table.name, table.columns);
      if (table.rowCount === 0) continue;

      for (const col of table.columns.slice(0, MAX_COLS_PER_TABLE)) {
        const enumerable =
          (col.distinctCount ?? Infinity) <= MAX_ENUM_DISTINCT &&
          (col.distinctCount ?? 0) > 0 &&
          !col.isPrimaryKey;

        if (enumerable) {
          await enumerateValues(handle, dialect, table.name, col);
        }
        if (isDateish(col.name, col.type) && !col.isPrimaryKey) {
          await profileDateFormats(handle, dialect, table.name, col);
        }
        // Flag high-cardinality free text so the model prefers LIKE over `=`.
        // Dates are excluded: LIKE is the wrong advice for a date column, and
        // they already carry their own format guidance.
        if (
          !enumerable &&
          isTextual(col.type) &&
          !col.isPrimaryKey &&
          !isDateish(col.name, col.type) &&
          (col.distinctCount ?? 0) > MAX_ENUM_DISTINCT
        ) {
          col.warnings = [
            ...(col.warnings || []),
            "high-cardinality free text — match with LIKE, never assume an exact literal",
          ];
        }
      }
    }

    return {
      dialect: dialectLabel(credentials.type),
      database: credentials.database,
      tables,
      foreignKeys: raw.fks,
      generatedAt: new Date().toISOString(),
      truncated: truncated.length ? truncated : undefined,
    };
  } finally {
    await handle.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Caching                                                                    */
/* -------------------------------------------------------------------------- */

export async function getSchemaContext(
  connectionId: string,
  orgId: string,
  opts: { forceRefresh?: boolean } = {}
): Promise<SchemaContext> {
  if (!opts.forceRefresh) {
    const conn = await prisma.databaseConnection.findFirst({
      where: { id: connectionId, organizationId: orgId },
      select: { schemaCache: true },
    });
    if (conn?.schemaCache) {
      try {
        const cached = JSON.parse(conn.schemaCache) as SchemaContext;
        const age = Date.now() - new Date(cached.generatedAt).getTime();
        if (cached.tables?.length && age < SCHEMA_CACHE_TTL_MS) {
          return cached;
        }
      } catch {
        /* corrupt cache — rebuild */
      }
    }
  }

  const ctx = await buildSchemaContext(connectionId, orgId);

  try {
    await prisma.databaseConnection.update({
      where: { id: connectionId },
      data: { schemaCache: JSON.stringify(ctx), lastTestedAt: new Date() },
    });
  } catch {
    /* caching is best-effort */
  }

  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Prompt rendering                                                           */
/* -------------------------------------------------------------------------- */

const pct = sharePct;

/**
 * Render the profiled schema as the model-facing document. Explicit, compact,
 * and ordered so the highest-value facts (join paths, exact code values) are
 * impossible to miss.
 */
export function renderSchemaForPrompt(ctx: SchemaContext): string {
  const out: string[] = [];

  out.push(`DIALECT: ${ctx.dialect}`);
  out.push(`DATABASE: ${ctx.database}`);
  out.push(`PROFILED AT: ${ctx.generatedAt}`);
  if (ctx.truncated?.length) {
    out.push(`NOTE: ${ctx.truncated.join(" ")}`);
  }
  out.push("");

  /* --- Join graph first: this is what the model gets wrong most often --- */
  out.push("=== VERIFIED JOIN PATHS (foreign keys read from the live database) ===");
  if (ctx.foreignKeys.length === 0) {
    out.push(
      "No foreign keys are declared in this database. Joins must be inferred from" +
        " column naming and confirmed against the row counts below. State any" +
        " inferred join as an assumption."
    );
  } else {
    for (const fk of ctx.foreignKeys) {
      out.push(
        `${fk.fromTable}.${fk.fromColumn}  ->  ${fk.toTable}.${fk.toColumn}`
      );
    }
    out.push("");
    out.push(
      "Use ONLY these paths to join. Any other join condition is a bug unless the" +
        " user explicitly asks for it."
    );
  }
  out.push("");

  /* --- Tables --- */
  out.push("=== TABLES ===");
  for (const t of ctx.tables) {
    out.push("");
    out.push(`TABLE ${t.name}  (${t.rowCount.toLocaleString()} rows)`);

    for (const c of t.columns) {
      const tags: string[] = [];
      if (c.isPrimaryKey) tags.push("PK");
      if (c.references) tags.push(`FK -> ${c.references.table}.${c.references.column}`);
      if (!c.nullable) tags.push("NOT NULL");

      let line = `  - ${c.name} : ${c.type}${tags.length ? "  [" + tags.join(", ") + "]" : ""}`;

      const facts: string[] = [];
      if (c.nullCount && t.rowCount) {
        facts.push(`${c.nullCount.toLocaleString()} NULLs (${pct(c.nullCount, t.rowCount)})`);
      }
      if (c.distinctCount !== undefined && !c.isPrimaryKey) {
        facts.push(`${c.distinctCount.toLocaleString()} distinct`);
      }
      if (facts.length) line += `\n      ${facts.join(", ")}`;

      if (c.min !== undefined && c.max !== undefined && !c.enumValues) {
        line += `\n      range: ${c.min} .. ${c.max}`;
      }

      if (c.dateFormats?.length) {
        line += `\n      stored date formats: ${c.dateFormats.join(", ")}`;
      }

      if (c.enumValues?.length) {
        const shown = c.enumValues.slice(0, MAX_ENUM_DISTINCT);
        const rendered = shown
          .map((v) => `'${v.value}' (${v.count.toLocaleString()})`)
          .join(", ");
        const more =
          c.enumValues.length > MAX_ENUM_DISTINCT ? ", ...more" : "";
        line += `\n      EXACT VALUES: ${rendered}${more}`;
      }

      if (c.warnings?.length) {
        line += `\n      !! ${c.warnings.join("; ")}`;
      }

      out.push(line);
    }
  }

  return out.join("\n");
}

/**
 * Kept for backwards compatibility with any existing callers of the old
 * introspectSchema(). Returns the rendered rich schema.
 */
export async function introspectSchema(
  connectionId: string,
  orgId: string
): Promise<string> {
  const ctx = await getSchemaContext(connectionId, orgId);
  return renderSchemaForPrompt(ctx);
}
