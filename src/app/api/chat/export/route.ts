import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeQuery, resolveQueryTarget } from "@/lib/db/queryRunner";
import { ScopeError } from "@/lib/db/scope";
import { TenantAccessError, assertConnectionAllowed } from "@/lib/embed/access";
import { isIdentifierColumn } from "@/lib/ai/facts";

/**
 * ============================================================================
 *  GET /api/chat/export?messageId=...&format=xlsx|csv
 * ============================================================================
 *  Exports the result behind one assistant answer.
 *
 *  WHY THE QUERY RE-RUNS INSTEAD OF EXPORTING THE ROWS THE BROWSER HOLDS
 *  --------------------------------------------------------------------
 *  The chat response carries at most 200 rows — enough to render an answer,
 *  not enough to be a spreadsheet. Exporting that sample would hand someone a
 *  file that looks like the full data set and is not, which is exactly the
 *  class of quiet wrongness the rest of this pipeline exists to prevent. So the
 *  stored SQL runs again, under the same read-only guard and row cap as the
 *  original, and the workbook records when it ran.
 *
 *  A consequence worth stating plainly, and stated in the file itself: the
 *  numbers in the export are current as of the export, not as of the answer. If
 *  the underlying data changed in between, the file will differ from the chat —
 *  which is the honest behaviour, but only if the file says so. The Query sheet
 *  carries both timestamps.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

const MAX_SHEET_NAME = 31;

/** Excel refuses these characters in a sheet name. */
function safeSheetName(name: string): string {
  return (
    name.replace(/[\\/?*\[\]:]/g, " ").trim().slice(0, MAX_SHEET_NAME) || "Data"
  );
}

/** Turn a question into a filename that survives every OS. */
function safeFileName(question: string, ext: string): string {
  const stem =
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "davis-export";
  const stamp = new Date().toISOString().slice(0, 10);
  return `davis-${stem}-${stamp}.${ext}`;
}

function isNumericValue(v: any): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  if (typeof v === "boolean") return false;
  const n = Number(String(v).trim());
  return Number.isFinite(n);
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * RFC 4180 quoting. Every field is quoted rather than only the ones that need
 * it: a leading zero, a leading '+' or a value that reads as a date is
 * otherwise silently reinterpreted when the file is opened, and a mangled
 * medical record number is worse than a wide file.
 */
function csvCell(v: any): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replace(/"/g, '""')}"`;
}

function toCsv(columns: string[], rows: any[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row?.[c])).join(","));
  }
  // The BOM is what makes Excel read the file as UTF-8 instead of the local
  // code page, which is the difference between "Müller" and "MÃ¼ller".
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                       */
/* -------------------------------------------------------------------------- */

async function toXlsx(args: {
  columns: string[];
  rows: any[];
  question: string;
  sql: string;
  assumptions: string[];
  connectionName: string;
  answeredAt: Date;
  truncated: boolean;
  totalRowCount: number | null;
}): Promise<Buffer> {
  // Imported lazily so a missing optional dependency degrades to "xlsx export
  // unavailable" rather than breaking every other route in the bundle.
  const ExcelJS = (await import("exceljs")).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = "DAVIS";
  wb.created = new Date();

  /* ---- Data sheet ---- */
  const ws = wb.addWorksheet(safeSheetName("Data"), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = args.columns.map((c) => ({
    header: c,
    key: c,
    width: Math.min(Math.max(c.length + 4, 12), 48),
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1E40AF" },
  };
  header.alignment = { vertical: "middle" };
  header.height = 20;

  // Identifiers are written as text. Excel will happily turn an eight-digit
  // account number into 1.2346E+07, or strip the leading zero off a postal code, and the
  // person who opens the file has no way to tell it happened.
  const identifierCols = new Set(
    args.columns.filter((c) => isIdentifierColumn(c))
  );

  for (const row of args.rows) {
    const values: Record<string, any> = {};
    for (const c of args.columns) {
      const v = row?.[c];
      if (v === null || v === undefined) {
        values[c] = null;
      } else if (identifierCols.has(c)) {
        values[c] = String(v);
      } else if (isNumericValue(v)) {
        values[c] = Number(v);
      } else {
        values[c] = String(v);
      }
    }
    ws.addRow(values);
  }

  for (const c of identifierCols) {
    ws.getColumn(c).numFmt = "@";
  }

  if (args.rows.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: args.columns.length },
    };
  }

  /* ---- Query sheet: what this file is and how to reproduce it ---- */
  const meta = wb.addWorksheet(safeSheetName("Query"));
  meta.columns = [
    { header: "", key: "k", width: 22 },
    { header: "", key: "v", width: 110 },
  ];

  const facts: Array<[string, string]> = [
    ["Question", args.question],
    ["Database", args.connectionName],
    ["Answered", args.answeredAt.toISOString()],
    ["Exported", new Date().toISOString()],
    ["Rows in this file", String(args.rows.length)],
  ];

  if (args.truncated) {
    facts.push([
      "Row cap",
      args.totalRowCount
        ? `Capped. ${args.totalRowCount.toLocaleString()} rows matched when the question was answered; this file holds the first ${args.rows.length.toLocaleString()}.`
        : `Capped. More rows match than this file holds.`,
    ]);
  }

  facts.push([
    "Note",
    "The query was re-run to build this file, so these figures are current as of the export time above, not the answer time.",
  ]);

  for (const [k, v] of facts) {
    const r = meta.addRow({ k, v });
    r.getCell("k").font = { bold: true };
    r.getCell("v").alignment = { wrapText: true, vertical: "top" };
  }

  if (args.assumptions.length) {
    meta.addRow({});
    const head = meta.addRow({ k: "Assumptions", v: "" });
    head.getCell("k").font = { bold: true };
    for (const a of args.assumptions) {
      const r = meta.addRow({ k: "", v: a });
      r.getCell("v").alignment = { wrapText: true, vertical: "top" };
    }
  }

  meta.addRow({});
  const sqlHead = meta.addRow({ k: "SQL", v: "" });
  sqlHead.getCell("k").font = { bold: true };
  const sqlRow = meta.addRow({ k: "", v: args.sql });
  sqlRow.getCell("v").font = { name: "Consolas", size: 10 };
  sqlRow.getCell("v").alignment = { wrapText: true, vertical: "top" };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* -------------------------------------------------------------------------- */
/* Route                                                                      */
/* -------------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const messageId = searchParams.get("messageId");
  const format = (searchParams.get("format") || "xlsx").toLowerCase();

  if (!messageId) {
    return NextResponse.json(
      { error: "messageId is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  if (format !== "xlsx" && format !== "csv") {
    return NextResponse.json(
      { error: "format must be xlsx or csv", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // Scoped through the session's organization, so a message id from another
  // tenant is a 404 rather than a data leak.
  const message = await prisma.chatMessage.findFirst({
    where: {
      id: messageId,
      session: { organizationId: user.organizationId },
    },
    include: { session: true, connection: true },
  });

  if (!message) {
    return NextResponse.json(
      { error: "Message not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  let metadata: any = {};
  try {
    metadata = message.metadata ? JSON.parse(message.metadata) : {};
  } catch {
    metadata = {};
  }

  const sql: string = metadata.sql || "";
  if (!sql || !message.connectionId) {
    return NextResponse.json(
      {
        error:
          "That answer has no query behind it, so there is nothing to export.",
        code: "NO_QUERY",
      },
      { status: 400 }
    );
  }

  // The question lives on the user message that preceded this answer.
  const priorQuestion = await prisma.chatMessage.findFirst({
    where: {
      sessionId: message.sessionId,
      role: "USER",
      createdAt: { lte: message.createdAt },
    },
    orderBy: { createdAt: "desc" },
  });
  const question = priorQuestion?.content || message.session.title || "DAVIS export";

  // The export re-runs the query, so it re-resolves the scope. It must not be
  // the back door that runs a tenant's SQL unscoped: the conversation's tenant
  // is the tenant, and a conversation whose tenant has since been suspended or
  // removed does not export.
  // Re-running a saved query is still a query. Someone whose tenant access was
  // narrowed since they asked it should not be able to run it again by way of
  // the export button.
  try {
    await assertConnectionAllowed(user.userId, user.organizationId, message.connectionId);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  let target;
  try {
    let tenantKey: string | null = null;
    if (message.session.tenantId) {
      const owner = await prisma.tenant.findUnique({
        where: { id: message.session.tenantId },
        select: { externalKey: true },
      });
      if (!owner) {
        return NextResponse.json(
          {
            error: "This conversation belongs to a tenant that no longer exists.",
            code: "NO_TENANT",
          },
          { status: 404 }
        );
      }
      tenantKey = owner.externalKey;
    }
    target = await resolveQueryTarget({
      connectionId: message.connectionId,
      organizationId: user.organizationId,
      tenantKey,
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    throw error;
  }

  const result = await executeQuery(target, sql);
  if (result.error) {
    return NextResponse.json(
      {
        error: `The query could not be re-run for export: ${result.error}`,
        code: "QUERY_FAILED",
      },
      { status: 502 }
    );
  }

  if (format === "csv") {
    const csv = toCsv(result.columns, result.rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFileName(question, "csv")}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const buffer = await toXlsx({
      columns: result.columns,
      rows: result.rows,
      question,
      sql,
      assumptions: Array.isArray(metadata.assumptions) ? metadata.assumptions : [],
      connectionName: message.connection?.name || "Unknown database",
      answeredAt: message.createdAt,
      truncated: result.truncated,
      totalRowCount:
        typeof metadata.totalRowCount === "number" ? metadata.totalRowCount : null,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFileName(question, "xlsx")}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("[davis] xlsx export failed:", error);
    return NextResponse.json(
      {
        error:
          "The spreadsheet could not be built. CSV export is unaffected — try that instead.",
        code: "EXPORT_FAILED",
        detail: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}
