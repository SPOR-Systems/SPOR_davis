import path from "path";
import { prisma } from "@/lib/prisma";
import { decryptText } from "@/lib/encryption";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import sqlite3 from "sqlite3";

/**
 * A single, reusable low-level connection abstraction.
 *
 * The old code opened a brand new connection for every single query, which made
 * schema profiling (which needs dozens of small queries) impossibly slow. Now a
 * caller opens one handle, issues as many queries as it likes, and closes it.
 */

export type Dialect = "POSTGRESQL" | "MYSQL" | "MARIADB" | "SQLITE";

export interface RawResult {
  columns: string[];
  rows: any[];
}

export interface DbHandle {
  dialect: Dialect;
  run(sql: string): Promise<RawResult>;
  close(): Promise<void>;
}

export interface DbCredentials {
  id: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

/** Human-readable dialect name for the LLM prompt. */
export function dialectLabel(type: string): string {
  switch (type.toUpperCase()) {
    case "POSTGRESQL":
      return "PostgreSQL";
    case "MYSQL":
      return "MySQL";
    case "MARIADB":
      return "MariaDB";
    case "SQLITE":
      return "SQLite";
    default:
      return type;
  }
}

export async function getDbCredentials(
  connectionId: string,
  orgId: string
): Promise<DbCredentials> {
  const conn = await prisma.databaseConnection.findFirst({
    where: { id: connectionId, organizationId: orgId },
  });

  if (!conn) {
    throw new Error("Database connection not found or access denied.");
  }

  return {
    id: conn.id,
    type: conn.type,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    password: decryptText(conn.encryptedPassword),
    ssl: conn.ssl,
  };
}

/** Resolve a SQLite `database` field to a real path on disk. */
function resolveSqlitePath(database: string): string {
  if (path.isAbsolute(database)) return database;
  return path.join(process.cwd(), database);
}

/**
 * Wrap a promise with a hard timeout so a runaway analytical query can never
 * hang a request forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

export const QUERY_TIMEOUT_MS = Number(process.env.DAVIS_QUERY_TIMEOUT_MS || 20000);

export async function openConnection(
  credentials: DbCredentials
): Promise<DbHandle> {
  const type = credentials.type.toUpperCase() as Dialect;

  if (type === "POSTGRESQL") {
    const client = new PgClient({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      ssl: credentials.ssl ? { rejectUnauthorized: false } : false,
      statement_timeout: QUERY_TIMEOUT_MS,
    });
    await client.connect();
    // Belt and braces: the session physically cannot write.
    await client.query("SET default_transaction_read_only = on");

    return {
      dialect: type,
      async run(sql: string) {
        const res: any = await withTimeout<any>(
          client.query(sql),
          QUERY_TIMEOUT_MS,
          "Query"
        );
        return {
          columns: (res.fields || []).map((f: any) => f.name),
          rows: res.rows || [],
        };
      },
      async close() {
        try {
          await client.end();
        } catch {
          /* already closed */
        }
      },
    };
  }

  if (type === "MYSQL" || type === "MARIADB") {
    const connection = await mysql.createConnection({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      ssl: credentials.ssl ? { rejectUnauthorized: false } : undefined,
      multipleStatements: false, // hard block on stacked queries
    });

    try {
      await connection.query(
        `SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`
      );
    } catch {
      /* MariaDB uses a different variable; non-fatal */
    }

    return {
      dialect: type,
      async run(sql: string) {
        const [rows, fields] = await withTimeout(
          connection.query(sql),
          QUERY_TIMEOUT_MS,
          "Query"
        );
        return {
          columns: ((fields as any[]) || []).map((f) => f.name),
          rows: (rows as any[]) || [],
        };
      },
      async close() {
        try {
          await connection.end();
        } catch {
          /* already closed */
        }
      },
    };
  }

  if (type === "SQLITE") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = sqlite3.verbose();
    const dbPath = resolveSqlitePath(credentials.database);

    const db = await new Promise<any>((resolve, reject) => {
      const handle = new sqlite.Database(
        dbPath,
        sqlite.OPEN_READONLY,
        (err: Error | null) => (err ? reject(err) : resolve(handle))
      );
    });

    return {
      dialect: type,
      async run(sql: string) {
        const rows = await withTimeout(
          new Promise<any[]>((resolve, reject) => {
            db.all(sql, (err: Error | null, result: any[]) =>
              err ? reject(err) : resolve(result || [])
            );
          }),
          QUERY_TIMEOUT_MS,
          "Query"
        );
        return {
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          rows,
        };
      },
      async close() {
        await new Promise<void>((resolve) => db.close(() => resolve()));
      },
    };
  }

  throw new Error(`Unsupported database type: ${credentials.type}`);
}

/** Convenience: open, use, always close. */
export async function withConnection<T>(
  connectionId: string,
  orgId: string,
  fn: (handle: DbHandle, credentials: DbCredentials) => Promise<T>
): Promise<T> {
  const credentials = await getDbCredentials(connectionId, orgId);
  const handle = await openConnection(credentials);
  try {
    return await fn(handle, credentials);
  } finally {
    await handle.close();
  }
}
