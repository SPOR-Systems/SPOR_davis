"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CHART_TYPE_LABELS,
  type ChartPayload,
  type ChartType,
} from "@/lib/ai/visualize";

/**
 * ============================================================================
 *  RESULT CHART
 * ============================================================================
 *  Draws the chart the server chose. The server owns the DECISION and the
 *  DATA; this component owns only the rendering, plus the switcher that lets
 *  the reader try a different form of the same points.
 *
 *  DESIGN RULES THIS FILE ENFORCES (each is a documented way charts mislead):
 *
 *  - ONE Y AXIS, ALWAYS. There is no second-axis code path here, deliberately.
 *    Two scales on one plot invent a correlation the data does not contain, and
 *    the server has already dropped any measure that cannot share the axis.
 *  - COLOUR FOLLOWS THE SERIES INDEX, NOT THE VALUE. A palette applied by rank
 *    repaints on every re-sort, so a reader who learned "blue is the Western region"
 *    gets a different answer next time. Single-series charts use one colour for
 *    every bar rather than a value ramp: a ramp double-encodes bar length as
 *    hue and burns the only free channel on information the chart already
 *    shows.
 *  - THE PALETTE IS VALIDATED, NOT CHOSEN BY EYE. The eight hues below clear
 *    the colour-blindness separation, chroma and contrast gates against this
 *    app's surface (#0C1220). Adding a ninth generated hue would break that,
 *    so past eight series the chart is not the right artefact.
 *  - THE CHART NEVER CARRIES A VALUE ALONE. Every figure in it is also in the
 *    answer text above and in the export, so nothing depends on hovering.
 * ============================================================================
 */

/** Validated for this app's dark surface. Order is the safety mechanism. */
const SERIES = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
];

/**
 * The "Other" slice is grey on purpose. It is a bucket, not a category, and
 * giving it a categorical hue would make it compete with the real ones for the
 * reader's attention. 3.93:1 against the surface, so it is still clearly
 * visible — de-emphasised, not hidden.
 */
const OTHER = "#64748B";

const INK_MUTED = "#64748B";
const INK_SECONDARY = "#94A3B8";
const GRID = "rgba(255,255,255,0.07)";
const SURFACE = "#0C1220";

const AXIS_TICK = { fill: INK_MUTED, fontSize: 11 };

/** Compact axis numbers: 1.2M reads; 1200000 does not. */
function tickNumber(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

/** Full precision in the tooltip — the axis abbreviates, the tooltip does not. */
function fullNumber(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v === null || v === undefined ? "—" : String(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && label !== null && (
        <p className="chart-tooltip-label">{String(label)}</p>
      )}
      {payload.map((entry: any, i: number) => (
        <p className="chart-tooltip-row" key={`${entry.dataKey}-${i}`}>
          <span
            className="chart-tooltip-swatch"
            style={{ background: entry.color || entry.fill }}
            aria-hidden="true"
          />
          <span className="chart-tooltip-name">{entry.name}</span>
          <span className="chart-tooltip-value">{fullNumber(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The chart                                                                  */
/* -------------------------------------------------------------------------- */

export default function ResultChart({ chart }: { chart: ChartPayload }) {
  const [type, setType] = useState<ChartType>(chart.type);
  const [showReason, setShowReason] = useState(false);

  const { data, seriesKeys, seriesLabels, x } = chart;

  /* Long category labels need room on the axis; measure once. */
  const longestLabel = useMemo(() => {
    if (!x) return 0;
    return data.reduce(
      (n, d) => Math.max(n, String(d?.[x] ?? "").length),
      0
    );
  }, [data, x]);

  if (!data.length || !seriesKeys.length) return null;

  const multi = seriesKeys.length > 1;
  const colourFor = (i: number) => SERIES[i % SERIES.length];

  const gridProps = {
    stroke: GRID,
    strokeDasharray: "0",
  } as const;

  const legend = multi ? (
    <Legend
      verticalAlign="bottom"
      height={28}
      iconType="circle"
      iconSize={8}
      wrapperStyle={{ fontSize: 11, color: INK_SECONDARY, paddingTop: 8 }}
    />
  ) : null;

  const height = type === "hbar" ? Math.max(200, data.length * 26 + 72) : 280;

  let body: React.ReactElement | null = null;

  if (type === "bar") {
    body = (
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barGap={2}>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey={x || undefined}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          interval="preserveStartEnd"
          tickFormatter={(v) => truncate(String(v ?? ""), 14)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickNumber}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
        {legend}
        {seriesKeys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            name={seriesLabels[i] || key}
            fill={colourFor(i)}
            radius={[4, 4, 0, 0]}
            stackId={chart.stacked ? "a" : undefined}
            maxBarSize={44}
          />
        ))}
      </BarChart>
    );
  } else if (type === "hbar") {
    body = (
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 20, bottom: 4, left: 4 }}
        barGap={2}
      >
        <CartesianGrid {...gridProps} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          tickFormatter={tickNumber}
        />
        <YAxis
          type="category"
          dataKey={x || undefined}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={Math.min(Math.max(longestLabel * 6.6, 80), 190)}
          tickFormatter={(v) => truncate(String(v ?? ""), 28)}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
        {legend}
        {seriesKeys.map((key, i) => (
          <Bar
            key={key}
            dataKey={key}
            name={seriesLabels[i] || key}
            fill={colourFor(i)}
            radius={[0, 4, 4, 0]}
            stackId={chart.stacked ? "a" : undefined}
            maxBarSize={22}
          />
        ))}
      </BarChart>
    );
  } else if (type === "line") {
    body = (
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey={x || undefined}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          interval="preserveStartEnd"
          minTickGap={24}
          tickFormatter={(v) => truncate(String(v ?? ""), 14)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickNumber}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: GRID }} />
        {legend}
        {seriesKeys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            name={seriesLabels[i] || key}
            stroke={colourFor(i)}
            strokeWidth={2}
            dot={data.length <= 30 ? { r: 3, strokeWidth: 0, fill: colourFor(i) } : false}
            activeDot={{ r: 5, stroke: SURFACE, strokeWidth: 2 }}
            connectNulls={false}
          />
        ))}
      </LineChart>
    );
  } else if (type === "area") {
    body = (
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <defs>
          {seriesKeys.map((key, i) => (
            <linearGradient id={`fill-${key}-${i}`} key={key} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colourFor(i)} stopOpacity={0.28} />
              <stop offset="100%" stopColor={colourFor(i)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey={x || undefined}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          interval="preserveStartEnd"
          minTickGap={24}
          tickFormatter={(v) => truncate(String(v ?? ""), 14)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickNumber}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: GRID }} />
        {legend}
        {seriesKeys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            name={seriesLabels[i] || key}
            stroke={colourFor(i)}
            strokeWidth={2}
            fill={`url(#fill-${key}-${i})`}
            stackId={chart.stacked ? "a" : undefined}
            connectNulls={false}
          />
        ))}
      </AreaChart>
    );
  } else if (type === "pie") {
    const key = seriesKeys[0];
    body = (
      <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          verticalAlign="bottom"
          height={30}
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 11, color: INK_SECONDARY }}
        />
        <Pie
          data={data}
          dataKey={key}
          nameKey={x || undefined}
          cx="50%"
          cy="48%"
          outerRadius={88}
          innerRadius={0}
          // A 2px surface ring rather than a border colour: it separates
          // adjacent slices without drawing a line the reader has to ignore.
          stroke={SURFACE}
          strokeWidth={2}
          isAnimationActive={false}
        >
          {data.map((_, i) => (
            <Cell
              key={i}
              fill={
                chart.foldTailAfter && i === data.length - 1
                  ? OTHER
                  : colourFor(i)
              }
            />
          ))}
        </Pie>
      </PieChart>
    );
  } else if (type === "scatter") {
    const key = seriesKeys[0];
    body = (
      <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid {...gridProps} />
        <XAxis
          type="number"
          dataKey={x || undefined}
          name={chart.xLabel}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          tickFormatter={tickNumber}
        />
        <YAxis
          type="number"
          dataKey={key}
          name={seriesLabels[0] || key}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickNumber}
          width={52}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: "0", stroke: GRID }} />
        <Scatter
          data={data}
          name={seriesLabels[0] || key}
          fill={colourFor(0)}
          stroke={SURFACE}
          strokeWidth={2}
        />
      </ScatterChart>
    );
  }

  if (!body) return null;

  const options = chart.alternatives.filter((t) => t !== "none");

  return (
    <figure className="chart-card">
      <div className="chart-head">
        {chart.title ? (
          <figcaption className="chart-title">{chart.title}</figcaption>
        ) : (
          <span />
        )}

        {options.length > 1 && (
          <div className="chart-switch" role="group" aria-label="Chart type">
            {options.map((t) => (
              <button
                key={t}
                type="button"
                className={t === type ? "chart-switch-btn is-active" : "chart-switch-btn"}
                onClick={() => setType(t)}
                aria-pressed={t === type}
              >
                {CHART_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="chart-plot" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {body}
        </ResponsiveContainer>
      </div>

      <div className="chart-foot">
        <button
          type="button"
          className="chart-why"
          onClick={() => setShowReason((v) => !v)}
          aria-expanded={showReason}
        >
          Why this chart
        </button>
        {chart.fromCappedResult && (
          <span className="chart-note">
            Partial — the query hit its row cap, so this shows the rows that were returned.
          </span>
        )}
        {chart.pointsCapped && (
          <span className="chart-note">
            Showing the first {data.length.toLocaleString()} points.
          </span>
        )}
      </div>

      {showReason && <p className="chart-reason">{chart.reason}</p>}
    </figure>
  );
}
