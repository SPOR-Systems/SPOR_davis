/**
 * Deterministic figure extraction.
 *
 * The prose model must never do arithmetic, and it must never restate a number
 * with different precision. So we compute and format every number here, in
 * code, and hand the model a fact sheet it can only copy from.
 */

export interface FactSheetInput {
  columns: string[];
  rows: any[];
  rowCount: number;
  truncated: boolean;
  totalRowCount?: number | null;
  answerShape?: string;
}

function isNumeric(v: any): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed !== "" && Number.isFinite(Number(trimmed));
  }
  return false;
}

/**
 * Identifiers are labels, not quantities. Order 1200 is not "1,200" — a
 * grouped identifier reads as a measurement and cannot be pasted back into a
 * query or looked up in a source system. Years, postal codes and reference
 * numbers have the same problem.
 */
const IDENTIFIER_TOKENS = new Set([
  "id",
  "ids",
  "num",
  "code",
  "cd",
  "npi",
  "mrn",
  "zip",
  "postal",
  "year",
  "yr",
  "phone",
  "ssn",
  "acct",
  "account",
  "sku",
  "ref",
]);

export function isIdentifierColumn(name: string): boolean {
  // The model aliases columns freely — SYS_ORD_ID, "Order ID", orderId and
  // order-id are all the same thing — so split on every plausible word
  // boundary, including camelCase, before matching whole tokens.
  const tokens = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  // Whole-token matching only. "identifier" is not an id, and "income" is not
  // a number — substring matching would misclassify both.
  return tokens.some((t) => IDENTIFIER_TOKENS.has(t));
}

/** Format a number without ever changing its value. */
export function formatNumber(v: any, opts: { identifier?: boolean } = {}): string {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return String(v);

  // Identifiers are printed bare — no grouping separators.
  if (opts.identifier) return String(v).trim();

  if (Number.isInteger(n)) {
    return n.toLocaleString("en-US");
  }

  // Preserve the value's own precision; only add separators.
  const raw = String(v).trim();
  const decimals = raw.includes(".") ? raw.split(".")[1].replace(/[^0-9]/g, "").length : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(decimals, 6),
    maximumFractionDigits: Math.min(Math.max(decimals, 0), 6),
  });
}

/**
 * Builds the VERIFIED FIGURES block.
 *
 * - Single-row results: every cell is listed as an exact labelled figure.
 * - Multi-row results: the numeric columns get an explicit, code-computed
 *   total/min/max so the model never needs to add a column up itself, plus the
 *   top rows spelled out.
 */
export function buildFactSheet(input: FactSheetInput): string {
  const { columns, rows, rowCount, truncated, totalRowCount } = input;

  if (rowCount === 0) {
    return "The query returned 0 rows. There are no figures to report.";
  }

  const lines: string[] = [];

  lines.push(
    `ROWS RETURNED: ${rowCount}${
      truncated
        ? totalRowCount
          ? ` (capped; ${totalRowCount.toLocaleString()} rows match in total)`
          : " (capped; more rows match)"
        : " (complete result set)"
    }`
  );
  lines.push("");

  if (rowCount === 1) {
    lines.push("EXACT VALUES FROM THE SINGLE RESULT ROW:");
    for (const col of columns) {
      const v = rows[0][col];
      if (v === null || v === undefined) {
        lines.push(`  ${col} = NULL (no value)`);
      } else if (isNumeric(v)) {
        const id = isIdentifierColumn(col);
        lines.push(
          `  ${col} = ${formatNumber(v, { identifier: id })}` +
            (id ? "   (identifier — print exactly, no separators)" : `   [raw: ${String(v)}]`)
        );
      } else {
        lines.push(`  ${col} = ${String(v)}`);
      }
    }
    return lines.join("\n");
  }

  // Multi-row: give per-column aggregates computed here, in code.
  // Summing or averaging an identifier column is meaningless, so identifiers
  // are excluded from the aggregate block entirely — offering "sum of
  // order ids" invites the model to quote a nonsense figure.
  const numericCols = columns.filter(
    (c) => !isIdentifierColumn(c) && rows.some((r) => isNumeric(r[c]))
  );

  if (numericCols.length && !truncated) {
    lines.push("COLUMN AGGREGATES (computed by the application over the full result set):");
    for (const col of numericCols) {
      const vals = rows
        .map((r) => Number(r[col]))
        .filter((n) => Number.isFinite(n));
      if (!vals.length) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const avg = sum / vals.length;
      lines.push(
        `  ${col}: sum=${formatNumber(sum)}, min=${formatNumber(min)}, ` +
          `max=${formatNumber(max)}, mean=${formatNumber(Number(avg.toFixed(4)))}, ` +
          `n=${vals.length}`
      );
    }
    lines.push("");
  } else if (numericCols.length && truncated) {
    lines.push(
      "COLUMN AGGREGATES: not available — the result set was capped, so any total" +
        " computed from these rows would be wrong. Do not state a total."
    );
    lines.push("");
  }

  // Tie detection on the leading measure column, so the model does not
  // announce a winner that is actually tied.
  const measure = numericCols[0];
  if (measure && rows.length >= 2) {
    const first = Number(rows[0][measure]);
    const second = Number(rows[1][measure]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      if (first === second) {
        lines.push(
          `TIE DETECTED: the top two rows have an identical ${measure} of ` +
            `${formatNumber(first)}. Report this as a tie.`
        );
        lines.push("");
      } else if (first !== 0 && Math.abs(first - second) / Math.abs(first) < 0.02) {
        lines.push(
          `NEAR TIE: the top two rows differ by less than 2% on ${measure} ` +
            `(${formatNumber(first)} vs ${formatNumber(second)}). Do not present the` +
            ` first as a clear leader.`
        );
        lines.push("");
      }
    }
  }

  lines.push("TOP ROWS, EXACT VALUES:");
  for (const row of rows.slice(0, 20)) {
    const cells = columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return `${c}=NULL`;
      return isNumeric(v)
        ? `${c}=${formatNumber(v, { identifier: isIdentifierColumn(c) })}`
        : `${c}=${String(v)}`;
    });
    lines.push(`  ${cells.join(" | ")}`);
  }

  return lines.join("\n");
}

/**
 * A plain-language answer built entirely in code, with no model involved.
 *
 * Used when every prose model in the chain is out of capacity. The query has
 * already run and the figures are already verified, so there is no reason to
 * fail the question just because the sentence-writer is unavailable — the user
 * gets their number, phrased plainly, with a note about why it reads like this.
 */
export function renderDeterministicAnswer(input: {
  columns: string[];
  rows: any[];
  rowCount: number;
  truncated: boolean;
  totalRowCount?: number | null;
  /** Why the written summary is missing, so the footnote tells the truth. */
  reason?: "model_unavailable" | "answer_too_long" | "low_quota";
}): string {
  const { columns, rows, rowCount, truncated, totalRowCount } = input;

  if (rowCount === 0) {
    return "No records matched that query.";
  }

  const lines: string[] = [];

  if (rowCount === 1) {
    const parts = columns.map((c) => {
      const v = rows[0][c];
      const label = c.replace(/_/g, " ");
      if (v === null || v === undefined) return `${label}: no value`;
      return `${label}: ${
        isNumeric(v)
          ? formatNumber(v, { identifier: isIdentifierColumn(c) })
          : String(v)
      }`;
    });
    lines.push(parts.join("  ·  "));
  } else {
    lines.push(`| ${columns.join(" | ")} |`);
    lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows.slice(0, 20)) {
      lines.push(
        `| ${columns
          .map((c) => {
            const v = row[c];
            if (v === null || v === undefined) return "—";
            return isNumeric(v)
              ? formatNumber(v, { identifier: isIdentifierColumn(c) })
              : String(v);
          })
          .join(" | ")} |`
      );
    }
    if (rowCount > 20) {
      lines.push("");
      lines.push(`Showing 20 of ${rowCount} rows returned.`);
    }
  }

  if (truncated) {
    lines.push("");
    lines.push(
      totalRowCount
        ? `This result was capped — ${totalRowCount.toLocaleString()} rows match in total.`
        : "This result was capped; more rows match."
    );
  }

  lines.push("");
  lines.push(
    input.reason === "low_quota"
      ? "_These are the verified figures from your database. The written summary was" +
          " skipped to conserve API quota._"
      : input.reason === "answer_too_long"
      ? "_These are the verified figures from your database. The written summary was" +
          " too long to finish, so the full result is shown directly instead._"
      : "_These are the verified figures from your database, shown without the usual" +
          " written summary because the language model was unavailable._"
  );

  return lines.join("\n");
}

/** Compact, token-efficient rendering of the rows for the answer prompt. */
export function buildDataPreview(
  columns: string[],
  rows: any[],
  maxRows = 20
): string {
  if (rows.length === 0) return "(no rows)";

  const shown = rows.slice(0, maxRows);
  const header = columns.join(" | ");
  const sep = columns.map(() => "---").join(" | ");
  const body = shown.map((r) =>
    columns
      .map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return "NULL";
        return String(v);
      })
      .join(" | ")
  );

  const out = [header, sep, ...body];
  if (rows.length > maxRows) {
    out.push(`... ${rows.length - maxRows} further row(s) not shown in this preview`);
  }
  return out.join("\n");
}
