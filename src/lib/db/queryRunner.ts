import { prisma } from "@/lib/prisma";
import { decryptText } from "@/lib/encryption";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";

export interface QueryResult {
  columns: string[];
  rows: any[];
  error?: string;
}

/**
 * Fetches the database connection and decrypts the password.
 */
async function getDbCredentials(connectionId: string, orgId: string) {
  const conn = await prisma.databaseConnection.findFirst({
    where: { id: connectionId, organizationId: orgId },
  });

  if (!conn) {
    throw new Error("Database connection not found or access denied.");
  }

  const password = decryptText(conn.encryptedPassword);
  return { ...conn, password };
}

/**
 * Introspects the schema (tables and columns) of the database to feed to the LLM.
 */
export async function introspectSchema(connectionId: string, orgId: string): Promise<string> {
  const credentials = await getDbCredentials(connectionId, orgId);

  try {
    if (credentials.type === "POSTGRESQL") {
      const client = new PgClient({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        user: credentials.username,
        password: credentials.password,
        ssl: credentials.ssl ? { rejectUnauthorized: false } : false,
      });

      await client.connect();
      // Simple introspection query for Postgres
      const res = await client.query(`
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position;
      `);
      await client.end();

      return formatSchema(res.rows, "table_name", "column_name", "data_type");
    } else if (credentials.type === "MYSQL" || credentials.type === "MARIADB") {
      const connection = await mysql.createConnection({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        user: credentials.username,
        password: credentials.password,
        ssl: credentials.ssl ? { rejectUnauthorized: false } : undefined,
      });

      const [rows] = await connection.execute(`
        SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name, DATA_TYPE as data_type
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION;
      `, [credentials.database]);

      await connection.end();
      return formatSchema(rows as any[], "table_name", "column_name", "data_type");
    } else if (credentials.type === "SQLITE") {
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = credentials.database === "dev.db" ? "./dev.db" : credentials.database;

      const schemaRows = await new Promise<any[]>((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err: Error) => {
          if (err) return reject(err);
          // SQLite introspection: list all tables and their PRAGMA table_info
          db.all("SELECT name as table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", async (err: Error, tables: any[]) => {
            if (err) return reject(err);

            let allColumns: any[] = [];
            let processed = 0;

            if (tables.length === 0) return resolve([]);

            tables.forEach(table => {
              db.all(`PRAGMA table_info('${table.table_name}')`, (err: Error, cols: any[]) => {
                if (err) return reject(err);

                cols.forEach(col => {
                  allColumns.push({
                    table_name: table.table_name,
                    column_name: col.name,
                    data_type: col.type
                  });
                });

                processed++;
                if (processed === tables.length) {
                  db.close();
                  resolve(allColumns);
                }
              });
            });
          });
        });
      });

      return formatSchema(schemaRows, "table_name", "column_name", "data_type");
    }

    return "Schema introspection for this database type is not yet fully supported in this demo.";
  } catch (error: any) {
    console.error("Schema Introspection Error:", error);
    throw new Error(`Failed to introspect schema: ${error.message}`);
  }
}

/**
 * Executes a raw SQL query. Only allows SELECT statements.
 */
export async function executeQuery(connectionId: string, orgId: string, query: string): Promise<QueryResult> {
  // Security Check: Basic verification that this is a read-only query
  const cleanQuery = query.trim().toUpperCase();
  if (!cleanQuery.startsWith("SELECT") && !cleanQuery.startsWith("WITH")) {
    return { columns: [], rows: [], error: "Security Error: Only SELECT queries are permitted." };
  }

  const credentials = await getDbCredentials(connectionId, orgId);

  try {
    if (credentials.type === "POSTGRESQL") {
      const client = new PgClient({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        user: credentials.username,
        password: credentials.password,
        ssl: credentials.ssl ? { rejectUnauthorized: false } : false,
      });

      await client.connect();
      const res = await client.query(query);
      await client.end();

      return {
        columns: res.fields.map((f: any) => f.name),
        rows: res.rows,
      };
    } else if (credentials.type === "MYSQL" || credentials.type === "MARIADB") {
      const connection = await mysql.createConnection({
        host: credentials.host,
        port: credentials.port,
        database: credentials.database,
        user: credentials.username,
        password: credentials.password,
        ssl: credentials.ssl ? { rejectUnauthorized: false } : undefined,
      });

      const [rows, fields] = await connection.execute(query);
      await connection.end();

      return {
        columns: (fields as any[]).map((f) => f.name),
        rows: rows as any[],
      };
    } else if (credentials.type === "SQLITE") {
      const sqlite3 = require('sqlite3').verbose();
      const dbPath = credentials.database === "dev.db" ? "./dev.db" : credentials.database;

      const res = await new Promise<{ columns: string[], rows: any[] }>((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err: Error) => {
          if (err) return reject(err);

          db.all(query, (err: Error, rows: any[]) => {
            db.close();
            if (err) return reject(err);

            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            resolve({ columns, rows });
          });
        });
      });

      return res;
    }

    return { columns: [], rows: [], error: "Database execution for this driver is not implemented in this demo." };
  } catch (error: any) {
    return { columns: [], rows: [], error: error.message };
  }
}

// Helper to format raw SQL results into a readable string for the LLM
function formatSchema(rows: any[], tableCol: string, colCol: string, typeCol: string): string {
  const tables: Record<string, string[]> = {};

  for (const row of rows) {
    const table = row[tableCol];
    const column = row[colCol];
    const type = row[typeCol];

    if (!tables[table]) tables[table] = [];
    tables[table].push(`${column} (${type})`);
  }

  let result = "";
  for (const [table, cols] of Object.entries(tables)) {
    result += `Table: ${table}\nColumns: ${cols.join(", ")}\n\n`;
  }
  return result;
}
