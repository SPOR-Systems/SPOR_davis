import type { SchemaContext, TableMeta, ColumnMeta } from "@/lib/db/schemaContext";

/**
 * ============================================================================
 *  SCHEMA SUMMARY — answering "what do you know about my database?"
 * ============================================================================
 *  Every fact below is already computed. The profiler walks the live database
 *  on connect and records row counts, null counts, distinct counts, exact value
 *  lists, min/max ranges, date formats and dirty-data warnings — and until now
 *  none of it could be spoken aloud, because every intent ended in a SQL
 *  statement and "describe yourself" is not a query.
 *
 *  Asked what it knew about the database, DAVIS routed to NOT_DATA_RELATED and
 *  replied with a description of its own features. It was sitting on a full
 *  profile and answered like a brochure.
 *
 *  WHY THIS IS BUILT IN CODE RATHER THAN HANDED TO THE MODEL
 *  --------------------------------------------------------
 *  Same reason facts.ts exists. A model given a schema document and asked to
 *  summarise it will produce plausible table names, round the row counts, and
 *  quietly invent a relationship that reads well. Every name and number here is
 *  assembled deterministically; the model's only job downstream is to write
 *  sentences around a list it cannot add to.
 * ============================================================================
 */

/** A column carrying a measurable quantity, as opposed to a label or a key. */
function isMeasure(col: ColumnMeta): boolean {
  if (col.isPrimaryKey || col.references) return false;
  if (/^(int|integer|bigint|smallint|decimal|numeric|real|float|double|money)/i.test(col.type)) {
    // An integer column with a handful of distinct values is a code, not a
    // quantity — averaging a status code produces a number that means nothing.
    return (col.distinctCount ?? Infinity) > 12;
  }
  return false;
}

function isTemporal(col: ColumnMeta): boolean {
  return (
    Boolean(col.dateFormats?.length) ||
    /(date|time|dt|_at|_on)$/i.test(col.name) ||
    /^(date|datetime|timestamp)/i.test(col.type)
  );
}

/** A column with a known, short value list — the things you can filter by. */
function isCategorical(col: ColumnMeta): boolean {
  return Boolean(col.enumValues?.length) && (col.distinctCount ?? 0) > 1;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export interface SchemaSummary {
  /** The deterministic fact sheet the prose model may draw from, and only it. */
  factSheet: string;
  /** Starting questions derived from the real columns, safe to offer verbatim. */
  suggestions: string[];
  tableCount: number;
  totalRows: number;
}

export function buildSchemaSummary(ctx: SchemaContext): SchemaSummary {
  const lines: string[] = [];
  const tables = [...ctx.tables].sort((a, b) => b.rowCount - a.rowCount);
  const totalRows = tables.reduce((n, t) => n + t.rowCount, 0);

  lines.push(`DATABASE: ${ctx.database} (${ctx.dialect})`);
  lines.push(
    `SIZE: ${tables.length} tables, ${totalRows.toLocaleString()} rows in total.`
  );
  lines.push(`PROFILED: ${ctx.generatedAt}`);

  if (ctx.truncated?.length) {
    // The most important line in the whole summary when it appears: everything
    // below describes a PART of the database, and an answer built on it can be
    // confidently wrong about anything outside the profiled set.
    lines.push("");
    lines.push(`!! INCOMPLETE PROFILE: ${ctx.truncated.join(" ")}`);
    lines.push(
      `!! Anything outside those tables is invisible — DAVIS does not know it exists.`
    );
  }

  /* ---- Tables ---------------------------------------------------------- */
  lines.push("");
  lines.push("TABLES, largest first:");
  for (const table of tables) {
    const measures = table.columns.filter(isMeasure).map((c) => c.name);
    const dates = table.columns.filter(isTemporal).map((c) => c.name);
    // A numeric column with few enough distinct values gets an exact value list
    // AND passes as a measure. Listing it in both roles on the same line reads
    // like two different columns.
    const cats = table.columns
      .filter((c) => isCategorical(c) && !isMeasure(c))
      .map((c) => c.name);

    const parts: string[] = [`${table.columns.length} columns`];
    if (measures.length) parts.push(`measures: ${measures.slice(0, 5).join(", ")}`);
    if (dates.length) parts.push(`dates: ${dates.slice(0, 3).join(", ")}`);
    if (cats.length) parts.push(`filterable: ${cats.slice(0, 5).join(", ")}`);

    lines.push(
      `  ${table.name} — ${table.rowCount.toLocaleString()} rows · ${parts.join(" · ")}`
    );
  }

  /* ---- How the tables connect ------------------------------------------ */
  if (ctx.foreignKeys.length) {
    lines.push("");
    lines.push("HOW THEY CONNECT (verified foreign keys):");
    for (const fk of ctx.foreignKeys) {
      lines.push(`  ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}.${fk.toColumn}`);
    }
  } else {
    lines.push("");
    lines.push(
      "HOW THEY CONNECT: no foreign keys are declared, so DAVIS cannot verify any join " +
        "path. Questions spanning two tables will need the relationship spelled out."
    );
  }

  /* ---- What will bite you ---------------------------------------------- */
  // This is the part that answers "what do I need to understand". A list of
  // tables is an inventory; the data-quality findings are the things that will
  // silently corrupt an answer if nobody knows about them.
  const quality: string[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      // One line per column, not one per finding. A column with a warning AND a
      // mixed-format list was being reported twice, which reads as two separate
      // problems and pads the section that most needs to be read.
      const notes: string[] = [];
      let consequence = "";

      if (col.warnings?.length) {
        notes.push(col.warnings.join("; "));
        // The consequence has to match the warning. Every finding used to end
        // with "grouping on it raw would split one real category" — including
        // free-text and date columns, where it is simply untrue.
        const w = col.warnings.join(" ").toLowerCase();
        if (w.includes("casing") || w.includes("whitespace")) {
          consequence =
            "Grouping or filtering on it raw splits one real category across several rows.";
        }
        // No branch for high-cardinality: that warning already ends with "match
        // with LIKE, never assume an exact literal", and repeating it makes the
        // line read as two findings.
      }

      if (col.dateFormats && col.dateFormats.length > 1) {
        notes.push(`formats seen: ${col.dateFormats.join(", ")}`);
        consequence =
          "Date comparisons must normalise every format first, or rows silently drop out.";
      }

      if (notes.length) {
        const body = notes.join(" · ");
        quality.push(
          `  ${table.name}.${col.name} — ${body}` +
            (consequence ? `${body.endsWith(".") ? "" : "."} ${consequence}` : "")
        );
      }

      const nulls = col.nullCount ?? 0;
      if (nulls > 0 && table.rowCount > 0) {
        const share = pct(nulls, table.rowCount);
        if (share >= 20) {
          quality.push(
            `  ${table.name}.${col.name} — ${share}% empty (${nulls.toLocaleString()} rows). ` +
              `An average over it covers only the ${100 - share}% that have a value.`
          );
        }
      }
    }
  }

  lines.push("");
  if (quality.length) {
    lines.push("DATA QUALITY — things that change what an answer means:");
    lines.push(...quality.slice(0, 25));
    if (quality.length > 25) {
      lines.push(`  ... and ${quality.length - 25} further findings.`);
    }
  } else {
    lines.push(
      "DATA QUALITY: nothing flagged — no mixed date formats, inconsistent casing or " +
        "heavily empty columns were found."
    );
  }

  /* ---- Value lists ------------------------------------------------------ */
  const valueLists: string[] = [];
  for (const table of tables) {
    for (const col of table.columns) {
      // Same gate as the table line: a column whose only value is "1" is not a
      // filter, it is a constant.
      if (isCategorical(col) && !isMeasure(col)) {
        valueLists.push(
          `  ${table.name}.${col.name}: ${col.enumValues!
            .slice(0, 8)
            .map((v) => v.value)
            .join(", ")}${col.enumValues!.length > 8 ? ", …" : ""}`
        );
      }
    }
  }
  if (valueLists.length) {
    lines.push("");
    lines.push("EXACT VALUES you can filter by:");
    lines.push(...valueLists.slice(0, 20));
  }

  return {
    factSheet: lines.join("\n"),
    suggestions: buildSuggestions(tables, ctx),
    tableCount: tables.length,
    totalRows,
  };
}

/**
 * Starting questions, derived from the columns that actually exist.
 *
 * Not a generic list. Each one names real tables and columns, so every
 * suggestion is answerable — which is the difference between a useful prompt
 * and a menu of questions that return "I could not map that onto the data".
 */
function buildSuggestions(tables: TableMeta[], ctx: SchemaContext): string[] {
  const out: string[] = [];

  const biggest = tables[0];
  if (biggest) out.push(`How many rows are in ${biggest.name}?`);

  for (const table of tables) {
    const date = table.columns.find(isTemporal);
    if (date && out.length < 6) {
      out.push(`Show ${table.name} per month, by ${date.name}`);
      break;
    }
  }

  for (const table of tables) {
    const cat = table.columns.find(isCategorical);
    if (cat && out.length < 6) {
      out.push(`Break down ${table.name} by ${cat.name}`);
      break;
    }
  }

  for (const table of tables) {
    const measure = table.columns.find(isMeasure);
    if (measure && out.length < 6) {
      out.push(`What is the average ${measure.name} in ${table.name}?`);
      break;
    }
  }

  const fk = ctx.foreignKeys[0];
  if (fk && out.length < 6) {
    out.push(`How many ${fk.fromTable} rows are there per ${fk.toTable}?`);
  }

  return out;
}
