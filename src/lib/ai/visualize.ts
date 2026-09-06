import { isIdentifierColumn } from "@/lib/ai/facts";

/**
 * ============================================================================
 *  VISUALIZATION SELECTION
 * ============================================================================
 *  The planner proposes a chart; this module decides whether that proposal
 *  survives contact with the data that actually came back.
 *
 *  Why both halves are needed:
 *
 *  - The PLANNER knows intent. It is the only part of the system that knows
 *    "share of encounters" is a part-to-whole question and "encounters per
 *    month" is a trend. Column names alone cannot tell you that.
 *  - The PLANNER does not know the RESULT. It writes the spec before a single
 *    row exists, so it can name a column that got aliased differently, ask for
 *    a pie of forty slices, or put a count and a percentage on one axis.
 *
 *  So the planner's suggestion is treated as a hypothesis and every field is
 *  re-checked here against the real columns, types and row count. Anything that
 *  fails is corrected — not discarded — and the correction is recorded in
 *  `reason`, which the UI shows. A chart that silently misrepresents the data
 *  is the visual equivalent of a wrong number, and this codebase already treats
 *  a confidently wrong number as the worst possible outcome.
 *
 *  RULES ENFORCED HERE (each one is a known way charts mislead):
 *   - Never two measures of different magnitude on one axis. A dual-scale plot
 *     invents a correlation that is not in the data; the smaller series is
 *     drawn flat against the larger one. Mismatched measures are dropped.
 *   - Never a pie of many slices, of negative values, or of things that are not
 *     parts of a whole.
 *   - Never a bar chart of identifiers. Summing or plotting an ID is nonsense.
 *   - Never a chart with more category marks than can be read; past the cap the
 *     markdown table in the answer is the better artefact and we say so.
 *   - A SINGLE FIGURE GETS NO CHART AT ALL. Not a one-bar bar chart, and not a
 *     tile repeating the number either: the answer's first sentence already
 *     states it, so any card beside that sentence is the same figure printed
 *     twice. A chart earns its place by showing a shape the sentence cannot —
 *     a trend, a ranking, a distribution. One number has no shape.
 * ============================================================================
 */

export type ChartType =
  | "none"
  | "bar"
  | "hbar"
  | "line"
  | "area"
  | "pie"
  | "scatter";

/** How to refer to each form in a sentence, for the answer prompt. */
export const CHART_TYPE_PROSE: Record<ChartType, string> = {
  none: "no chart",
  bar: "column chart",
  hbar: "horizontal bar chart",
  line: "line chart",
  area: "area chart",
  pie: "pie chart",
  scatter: "scatter plot",
};

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  none: "No chart",
  bar: "Column",
  hbar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  scatter: "Scatter",
};

/** What the planner is allowed to send us. "auto" means "you decide". */
export type ChartTypeRequest = ChartType | "auto";

export interface PlannerVisualization {
  type: ChartTypeRequest;
  x: string;
  y: string[];
  series: string;
  stacked: boolean;
  title: string;
  reason: string;
}

export interface ChartSpec {
  type: ChartType;
  /** Category / time axis column. */
  x: string | null;
  /** Measure columns. Always same-scale; see enforceOneScale. */
  y: string[];
  /** Long-format grouping column, pivoted into one line/bar per value. */
  series: string | null;
  stacked: boolean;
  title: string;
  /** Why this form — shown in the UI so the choice is auditable, not magic. */
  reason: string;
  source: "planner" | "planner-corrected" | "heuristic";
  /** Other forms that are legitimate for this data, for the UI switcher. */
  alternatives: ChartType[];
  /**
   * For a pie with more categories than slices can carry: keep this many of
   * the largest and sum the rest into a single "Other" slice. Null when the
   * whole result is drawn as-is.
   */
  foldTailAfter: number | null;
}

/**
 * Can the small categories be added together into one "Other" slice?
 *
 * Counts, sums, and shares of a whole can: five categories at 2% each really
 * are 10% of the whole. Averages, rates, medians and per-unit figures cannot —
 * the mean of five departments is not the sum of their means, and an "Other"
 * slice built that way would be a fabricated number sitting in a chart that
 * looks authoritative. When the measure is one of those, a pie is refused
 * rather than faked.
 */
const NON_ADDITIVE = /(^|_)(avg|average|mean|median|mode|rate|ratio|min|max|minimum|maximum|stddev|stdev|sd|variance|var|per)(_|$)/i;

export function isAdditiveMeasure(name: string): boolean {
  return !NON_ADDITIVE.test(String(name || ""));
}

/* -------------------------------------------------------------------------- */
/* Column profiling                                                           */
/* -------------------------------------------------------------------------- */

export type ColumnRole = "measure" | "temporal" | "category" | "identifier" | "text";

export interface ColumnProfile {
  name: string;
  role: ColumnRole;
  distinct: number;
  nonNull: number;
  /** Longest label, used to decide column-vs-bar orientation. */
  maxLabelLength: number;
  min: number | null;
  max: number | null;
  allNonNegative: boolean;
}

/**
 * Bars run horizontally once the category names stop fitting under a column.
 * Rotated 45-degree tick labels are the usual alternative and they are worse:
 * they are slower to read, they collide at the ends of the axis, and the
 * longest one gets clipped by the container.
 */
function prefersHorizontal(label: ColumnProfile, rowCount: number): boolean {
  return label.maxLabelLength > 10 || rowCount > 8;
}

/** Marks past this many categories stop being readable; the table wins. */
const MAX_CATEGORY_MARKS = 40;
/** A pie stops communicating past this many slices. */
const MAX_PIE_SLICES = 6;
/**
 * Two measures whose magnitudes differ by more than this cannot share an axis:
 * the smaller one is drawn as a flat line along the baseline.
 */
const MAX_SCALE_RATIO = 50;

const TEMPORAL_NAME = /(^|_)(date|dt|day|week|wk|month|mon|mth|quarter|qtr|year|yr|period|time|ts|timestamp|created|updated|admitted|discharged|dob|birth)(_|$)/i;

const DATE_VALUE =
  /^\s*(\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?|\d{4}\/\d{2}(\/\d{2})?|\d{2}\/\d{2}\/\d{4})\s*$/;

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function looksTemporal(name: string, values: any[]): boolean {
  if (TEMPORAL_NAME.test(String(name))) {
    // A "year" column of 2019..2026 is temporal; a "year" column holding 4
    // distinct strings like "FY24" is still an ordered axis, so either way the
    // name is enough once we know the values are not free text.
    return true;
  }
  if (values.length === 0) return false;
  const dated = values.filter((v) => DATE_VALUE.test(String(v))).length;
  return dated / values.length >= 0.8;
}

export function profileColumns(columns: string[], rows: any[]): ColumnProfile[] {
  return columns.map((name) => {
    const raw = rows.map((r) => r?.[name]);
    const present = raw.filter((v) => v !== null && v !== undefined && v !== "");
    const nums = present.map(toNum);
    const numericCount = nums.filter((n) => n !== null).length;
    const numeric = present.length > 0 && numericCount / present.length >= 0.95;
    const finite = nums.filter((n): n is number => n !== null);

    const distinct = new Set(present.map((v) => String(v))).size;
    const maxLabelLength = present.reduce(
      (n, v) => Math.max(n, String(v).length),
      0
    );

    const temporal = looksTemporal(name, present);
    const identifier = isIdentifierColumn(name);

    let role: ColumnRole;
    if (temporal) {
      role = "temporal";
    } else if (identifier) {
      // An identifier is a label even when it is stored as a number. Plotting
      // the sum of order IDs is meaningless, so it is never a measure.
      role = "identifier";
    } else if (numeric) {
      role = "measure";
    } else if (maxLabelLength > 60) {
      // Free prose — a chief complaint, an address — cannot be an axis label.
      role = "text";
    } else {
      // Everything else is a label, including a column with a different value
      // in every row: a list of provider names IS the category axis. Whether
      // there are too many of them to draw is a separate question, answered by
      // the mark cap below — and answering it there means the user is told
      // "sixty categories is too many to read", not the misleading "there is
      // no label column here".
      role = "category";
    }

    return {
      name,
      role,
      distinct,
      nonNull: present.length,
      maxLabelLength,
      min: finite.length ? Math.min(...finite) : null,
      max: finite.length ? Math.max(...finite) : null,
      allNonNegative: finite.every((n) => n >= 0),
    };
  });
}

const byName = (profiles: ColumnProfile[], name: string | null | undefined) =>
  name ? profiles.find((p) => p.name === name) || null : null;

/* -------------------------------------------------------------------------- */
/* One axis, one scale                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Drops measures that cannot honestly share a y-axis with the first one.
 *
 * A count of 40,000 and a percentage of 12 plotted together produce a chart
 * where the percentage is a flat line on the baseline — the reader concludes it
 * never changes. The alternative, a second y-axis, is worse: the alignment
 * between two scales is arbitrary, so the chart implies a relationship the data
 * does not contain. Dropping the mismatched series is the only honest option,
 * and the caller records the drop in `reason`.
 */
function enforceOneScale(
  measures: string[],
  profiles: ColumnProfile[]
): { kept: string[]; dropped: string[] } {
  if (measures.length <= 1) return { kept: measures, dropped: [] };

  const magnitude = (name: string): number => {
    const p = byName(profiles, name);
    if (!p) return 0;
    return Math.max(Math.abs(p.max ?? 0), Math.abs(p.min ?? 0));
  };

  const anchor = magnitude(measures[0]) || 1;
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const m of measures) {
    const mag = magnitude(m) || 1;
    const ratio = Math.max(anchor / mag, mag / anchor);
    if (ratio <= MAX_SCALE_RATIO) kept.push(m);
    else dropped.push(m);
  }

  return { kept: kept.length ? kept : [measures[0]], dropped };
}

/* -------------------------------------------------------------------------- */
/* Deterministic choice — the fallback, and the check on the planner          */
/* -------------------------------------------------------------------------- */

export function chooseChart(
  profiles: ColumnProfile[],
  rowCount: number
): ChartSpec {
  const none = (reason: string): ChartSpec => ({
    type: "none",
    x: null,
    y: [],
    series: null,
    stacked: false,
    title: "",
    reason,
    source: "heuristic",
    alternatives: [],
    foldTailAfter: null,
  });

  if (rowCount === 0) return none("no rows to plot");

  const measures = profiles.filter((p) => p.role === "measure");
  if (measures.length === 0) {
    return none("the result has no numeric measure to plot");
  }

  /* A single row is a figure, not a chart. The answer states it in words
     directly above, so anything drawn here is that number a second time. */
  if (rowCount === 1) {
    return none(
      "a single figure has no shape to plot, and the answer already states it"
    );
  }

  const temporal = profiles.find((p) => p.role === "temporal");
  const category = profiles.find((p) => p.role === "category");
  const identifier = profiles.find((p) => p.role === "identifier");
  const label = temporal || category || identifier || null;

  if (!label) return none("the result has no label column to plot against");

  const { kept, dropped } = enforceOneScale(
    measures.map((m) => m.name),
    profiles
  );

  const dropNote = dropped.length
    ? ` ${dropped.join(", ")} left off — its scale is too different to share an axis honestly`
    : "";

  /* Trend over time. A line survives far more points than bars do. */
  if (temporal) {
    const type: ChartType = kept.length === 1 ? "area" : "line";
    return {
      type,
      x: temporal.name,
      y: kept,
      series: null,
      stacked: false,
      title: "",
      reason: `${temporal.name} is a time axis, so the shape over time is the point.${dropNote}`,
      source: "heuristic",
      alternatives: ["line", "area", "bar"],
      foldTailAfter: null,
    };
  }

  if (rowCount > MAX_CATEGORY_MARKS) {
    return none(
      `${rowCount} categories is past the point where bars can be read; the table above carries the values`
    );
  }

  /* A second low-cardinality label turns one measure into grouped series. */
  const grouping = profiles.find(
    (p) =>
      p !== label &&
      (p.role === "category" || p.role === "identifier") &&
      p.distinct >= 2 &&
      p.distinct <= 6
  );

  const horizontal = prefersHorizontal(label, rowCount);
  const type: ChartType = horizontal ? "hbar" : "bar";

  return {
    type,
    x: label.name,
    y: kept.slice(0, 4),
    series: grouping && kept.length === 1 ? grouping.name : null,
    stacked: false,
    title: "",
    reason:
      (horizontal
        ? "long category names read better on horizontal bars"
        : "comparing a measure across categories") + dropNote,
    source: "heuristic",
    alternatives: alternativesFor(type, profiles, rowCount, kept.length, kept[0]),
    foldTailAfter: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Validating the planner's proposal                                          */
/* -------------------------------------------------------------------------- */

/**
 * Takes the planner's suggestion and returns a spec that is true of the data.
 *
 * The planner's intent is respected wherever the data supports it; every
 * correction is appended to `reason` so the UI can explain, on demand, why the
 * chart is not the one that was asked for.
 */
export function resolveChartSpec(args: {
  suggestion?: PlannerVisualization | null;
  columns: string[];
  rows: any[];
  rowCount: number;
  answerShape?: string;
}): ChartSpec {
  const { suggestion, columns, rows, rowCount } = args;
  const profiles = profileColumns(columns, rows);
  const fallback = chooseChart(profiles, rowCount);

  if (!suggestion || !suggestion.type || suggestion.type === "auto") {
    return fallback;
  }
  if (suggestion.type === "none") {
    return { ...fallback, type: "none", reason: "the planner judged a chart unhelpful here", source: "planner" };
  }
  if (rowCount === 0) return fallback;

  const corrections: string[] = [];
  let type: ChartType = suggestion.type;
  let foldTailAfter: number | null = null;

  /* --- x --- */
  let x: string | null = byName(profiles, suggestion.x)?.name ?? null;
  if (suggestion.x && !x) {
    corrections.push(`"${suggestion.x}" is not a column in the result`);
  }
  if (!x) {
    x = fallback.x;
  }

  /* --- y: real, numeric, not identifiers --- */
  const requested = (Array.isArray(suggestion.y) ? suggestion.y : []).filter(Boolean);
  let y = requested.filter((name) => byName(profiles, name)?.role === "measure");

  const rejected = requested.filter((n) => !y.includes(n));
  if (rejected.length) {
    corrections.push(
      `${rejected.join(", ")} cannot be plotted as a measure`
    );
  }
  if (y.length === 0) y = fallback.y;
  if (y.length === 0) {
    return { ...fallback, type: "none", reason: "no plottable measure in the result", source: "planner-corrected" };
  }

  const scale = enforceOneScale(y, profiles);
  if (scale.dropped.length) {
    corrections.push(
      `${scale.dropped.join(", ")} left off the axis — its scale differs too much to share one honestly`
    );
  }
  y = scale.kept;

  /* --- series --- */
  const seriesProfile = byName(profiles, suggestion.series);
  const series: string | null =
    seriesProfile && seriesProfile.name !== x && seriesProfile.distinct <= 8
      ? seriesProfile.name
      : null;
  if (suggestion.series && !series) {
    corrections.push(`"${suggestion.series}" is not usable as a series split`);
  }

  const xProfile = byName(profiles, x);

  /* --- type, checked against what the data can actually support --- */
  if (rowCount === 1) {
    // Even when a chart was explicitly asked for. There is nothing to draw:
    // one number has no distribution, no trend and no ranking, and a card
    // repeating it beside the sentence that already says it is noise.
    return {
      ...fallback,
      type: "none",
      reason:
        "a single figure has no shape to plot, and the answer already states it",
      source: "planner-corrected",
    };
  }

  if (type === "pie") {
    if (y.length > 1) {
      y = [y[0]];
      corrections.push("a pie shows one measure, so only the first is drawn");
    }

    const values = rows
      .map((r) => toNum(r?.[y[0]]))
      .filter((n): n is number => n !== null);

    if (values.some((n) => n < 0)) {
      // A negative slice has no area to occupy. This one is not a matter of
      // readability — the chart cannot represent the number at all.
      type = "bar";
      corrections.push("negative values have no meaning as pie slices");
    } else if (rowCount > MAX_PIE_SLICES) {
      // Asking for a pie is a legitimate request, and past six slices the
      // problem is readability, not honesty — so the request is kept and the
      // tail is folded, which is the standard fix, rather than overruled.
      if (isAdditiveMeasure(y[0]) && rowCount <= MAX_CATEGORY_MARKS) {
        foldTailAfter = MAX_PIE_SLICES - 1;
        corrections.push(
          `${rowCount} categories is more than a pie can separate, so the ` +
            `${rowCount - foldTailAfter} smallest are grouped into one "Other" slice`
        );
      } else {
        type = rowCount > MAX_CATEGORY_MARKS ? "none" : "bar";
        corrections.push(
          rowCount > MAX_CATEGORY_MARKS
            ? `${rowCount} categories is past what any chart can separate`
            : `${y[0]} is an average or rate, so the small categories cannot be added ` +
              `together into an "Other" slice without inventing a figure — bars instead`
        );
      }
    }
  }

  if ((type === "line" || type === "area") && xProfile && xProfile.role === "category") {
    // Lines imply a continuum between the points. Across unordered categories
    // that continuum does not exist, and the slope invites a reading of "trend"
    // that the data cannot support.
    type = "bar";
    corrections.push(
      `${xProfile.name} is a set of categories, not a sequence, so a line between them would imply a trend that is not there`
    );
  }

  if (type === "scatter") {
    const xNumeric = xProfile && (xProfile.role === "measure" || xProfile.role === "temporal");
    if (!xNumeric) {
      type = fallback.type;
      corrections.push("a scatter needs a numeric x axis");
    }
  }

  if (
    (type === "bar" || type === "hbar" || (type === "pie" && !foldTailAfter)) &&
    rowCount > MAX_CATEGORY_MARKS
  ) {
    type = "none";
    corrections.push(
      `${rowCount} categories is past the point where marks can be told apart; the table carries the values`
    );
  }

  // Orientation is layout, not meaning: a column chart and a bar chart show the
  // same thing. It is applied silently rather than reported as a correction,
  // and the reader can flip it back with the switcher.
  if (type === "bar" && xProfile && prefersHorizontal(xProfile, rowCount)) {
    type = "hbar";
  }

  const base = String(suggestion.reason || "").trim();
  const reason = corrections.length
    ? `${base || "planner's choice"} — adjusted: ${corrections.join("; ")}`
    : base || fallback.reason;

  return {
    type,
    x,
    y,
    series,
    stacked: Boolean(suggestion.stacked) && (type === "bar" || type === "hbar" || type === "area"),
    title: String(suggestion.title || "").slice(0, 120),
    reason,
    source: corrections.length ? "planner-corrected" : "planner",
    alternatives: alternativesFor(type, profiles, rowCount, y.length, y[0]),
    foldTailAfter: type === "pie" ? foldTailAfter : null,
  };
}

/**
 * Chart types that would also be defensible for this result set.
 *
 * This is what the switcher above the chart offers, so anything genuinely
 * available belongs here — a form the reader can see but not reach is worse
 * than one that was never offered. Pie is listed whenever the measure could
 * honestly be folded into an "Other" slice, which is most of the time; it is
 * withheld only where a pie would be a lie rather than merely a poor choice.
 */
export function alternativesFor(
  current: ChartType,
  profiles: ColumnProfile[],
  rowCount: number,
  measureCount: number,
  measureName?: string
): ChartType[] {
  if (rowCount <= 1) return [];
  const out = new Set<ChartType>();
  const temporal = profiles.some((p) => p.role === "temporal");

  if (rowCount <= MAX_CATEGORY_MARKS) {
    out.add("bar");
    out.add("hbar");
  }
  if (temporal || rowCount > 6) {
    out.add("line");
    out.add("area");
  }
  if (
    measureCount === 1 &&
    rowCount <= MAX_CATEGORY_MARKS &&
    (rowCount <= MAX_PIE_SLICES || isAdditiveMeasure(measureName || ""))
  ) {
    out.add("pie");
  }
  out.add(current);
  return [...out];
}

/* -------------------------------------------------------------------------- */
/* Shaping rows for the chart library                                         */
/* -------------------------------------------------------------------------- */

export interface ChartData {
  data: Array<Record<string, any>>;
  /** The keys to draw one mark per. */
  seriesKeys: string[];
  /** Human labels for those keys, in the same order. */
  seriesLabels: string[];
}

/** Turn a column name into something a person would put on an axis. */
export function humanLabel(name: string): string {
  const cleaned = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
  if (!cleaned) return name;
  return cleaned
    .split(/\s+/)
    .map((w) =>
      w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(" ");
}

/**
 * The complete thing the client needs to draw the chart.
 *
 * The chart is built HERE, from the full result set, rather than in the browser
 * from the row sample the response carries. The response deliberately truncates
 * `rows` to keep the payload small — drawing a twelve-month line from the first
 * 200 of 400 rows would silently amputate half the series and show a trend
 * ending in a cliff that does not exist. The points are shaped once, on the
 * server, against the same rows the figures were computed from.
 */
export interface ChartPayload extends ChartSpec {
  data: Array<Record<string, any>>;
  seriesKeys: string[];
  seriesLabels: string[];
  xLabel: string;
  yLabel: string;
  /** True when the query itself hit the row cap, so the chart is partial. */
  fromCappedResult: boolean;
  /** True when the chart itself had to drop points past MAX_PLOT_POINTS. */
  pointsCapped: boolean;
}

/** Past this, a chart is a solid block of ink and the browser struggles. */
const MAX_PLOT_POINTS = 2000;

export function buildChartPayload(args: {
  spec: ChartSpec;
  rows: any[];
  /** Whether the SQL result hit the query row cap. */
  truncated: boolean;
}): ChartPayload {
  const { spec, rows, truncated } = args;
  const shaped = buildChartData(spec, rows);

  const pointsCapped = shaped.data.length > MAX_PLOT_POINTS;
  const data = pointsCapped ? shaped.data.slice(0, MAX_PLOT_POINTS) : shaped.data;

  return {
    ...spec,
    data,
    seriesKeys: shaped.seriesKeys,
    seriesLabels: shaped.seriesLabels,
    xLabel: spec.x ? humanLabel(spec.x) : "",
    yLabel: spec.y.length === 1 ? humanLabel(spec.y[0]) : "",
    fromCappedResult: truncated,
    pointsCapped,
  };
}

export function buildChartData(spec: ChartSpec, rows: any[]): ChartData {
  if (spec.type === "none") {
    return { data: [], seriesKeys: [], seriesLabels: [] };
  }

  const xKey = spec.x;

  /* Long format: one column holds the series name, so pivot it wide. */
  if (spec.series && spec.y.length === 1 && xKey) {
    const measure = spec.y[0];
    const buckets = new Map<string, Record<string, any>>();
    const keys: string[] = [];

    for (const row of rows) {
      const xv = row?.[xKey];
      const label = String(xv ?? "—");
      const sv = String(row?.[spec.series] ?? "—");
      if (!keys.includes(sv)) keys.push(sv);

      const bucket = buckets.get(label) || { [xKey]: xv };
      bucket[sv] = toNum(row?.[measure]);
      buckets.set(label, bucket);
    }

    return {
      data: [...buckets.values()],
      seriesKeys: keys,
      seriesLabels: keys,
    };
  }

  /* Pie with a folded tail: keep the largest slices, sum the rest into one.
     The rows are re-sorted by value first — "the six biggest" is only true of
     the first six rows if the query happened to order by the measure, and a
     pie's slice order is presentation rather than data, so sorting it costs
     nothing and guarantees the label is honest. */
  if (spec.type === "pie" && spec.foldTailAfter && xKey && spec.y.length === 1) {
    const measure = spec.y[0];
    const sorted = [...rows].sort(
      (a, b) => (toNum(b?.[measure]) ?? 0) - (toNum(a?.[measure]) ?? 0)
    );
    const head = sorted.slice(0, spec.foldTailAfter);
    const tail = sorted.slice(spec.foldTailAfter);

    if (tail.length > 0) {
      const otherTotal = tail.reduce(
        (sum, r) => sum + (toNum(r?.[measure]) ?? 0),
        0
      );
      const folded = head.map((row) => ({
        [xKey]: row?.[xKey],
        [measure]: toNum(row?.[measure]),
      }));
      folded.push({
        [xKey]: `Other (${tail.length})`,
        [measure]: otherTotal,
      });

      return {
        data: folded,
        seriesKeys: [measure],
        seriesLabels: [humanLabel(measure)],
      };
    }
  }

  const data = rows.map((row) => {
    const out: Record<string, any> = {};
    if (xKey) out[xKey] = row?.[xKey];
    for (const m of spec.y) out[m] = toNum(row?.[m]);
    return out;
  });

  return {
    data,
    seriesKeys: spec.y,
    seriesLabels: spec.y.map(humanLabel),
  };
}
