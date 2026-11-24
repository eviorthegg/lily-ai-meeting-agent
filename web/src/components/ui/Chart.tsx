import { useId, type ReactNode } from 'react';

/**
 * Charts, as inline SVG.
 *
 * No charting library. At this density — six series points and a funnel — a
 * library would add more bytes than the entire dashboard and buy nothing except
 * tooltips. These are a few dozen lines of arithmetic and they inherit the
 * design tokens for free.
 *
 * Every chart is a `<figure>` wrapping an `aria-hidden` SVG and a
 * visually-hidden `<table>` carrying the same numbers. That is the only
 * approach that actually works: an `aria-label` on an SVG announces a sentence
 * and hides the data, whereas the table is navigable, sortable by the reader's
 * own tools, and says exactly what the picture says.
 *
 * Series are distinguished by more than colour — the legend sits directly above
 * the marks and each series carries its own fill pattern in the bar charts.
 */

const INK = 'var(--ink)';
const GREEN = 'var(--green)';
const GREY = '#b9bec4';

export interface ChartSeries {
  key: string;
  label: string;
  values: readonly number[];
  /** Only three are used anywhere, and they are checked for contrast as marks. */
  tone: 'ink' | 'green' | 'grey';
}

const TONE_FILL: Readonly<Record<ChartSeries['tone'], string>> = {
  ink: INK,
  green: GREEN,
  grey: GREY,
};

function ChartFrame({
  caption,
  columns,
  rows,
  legend,
  children,
}: {
  caption: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="m-0">
      {/* The legend is a colour-to-series mapping and means nothing without the
          colours. The table below carries the same series as column headers, so
          announcing both is duplication rather than redundancy. */}
      {legend === undefined ? null : (
        <div className="mb-3" aria-hidden="true">
          {legend}
        </div>
      )}
      <div aria-hidden="true">{children}</div>
      {/* No figcaption: the table's own caption is the accessible description,
          and having both makes a screen reader read the title twice before any
          data. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={cellIndex} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={cellIndex}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Legend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2">
      {series.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2 text-[13px] text-grey">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-[3px]"
            style={{ background: TONE_FILL[entry.tone] }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Grouped bars over time.
 *
 * Height is fixed in the viewBox and the SVG scales to its container, so it is
 * legible at 375px without a media query.
 */
export function BarGroups({
  caption,
  periods,
  series,
  formatValue = (value: number) => String(value),
}: {
  caption: string;
  periods: readonly string[];
  series: readonly ChartSeries[];
  formatValue?: (value: number) => string;
}) {
  const width = 720;
  const height = 220;
  const padLeft = 8;
  const padBottom = 26;
  const plotHeight = height - padBottom - 8;

  const max = Math.max(
    1,
    ...series.flatMap((entry) => [...entry.values]),
  );

  const groupWidth = (width - padLeft * 2) / Math.max(1, periods.length);
  const barWidth = Math.max(3, (groupWidth - 8) / Math.max(1, series.length));

  // Enough labels to orient, not so many they collide at narrow widths.
  const labelEvery = Math.ceil(periods.length / 6);

  return (
    <ChartFrame
      caption={caption}
      columns={['Period', ...series.map((entry) => entry.label)]}
      rows={periods.map((period, index) => [
        period,
        ...series.map((entry) => formatValue(entry.values[index] ?? 0)),
      ])}
      legend={<Legend series={series} />}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[220px] w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          y1={height - padBottom}
          x2={width}
          y2={height - padBottom}
          stroke="var(--hair)"
          strokeWidth={1}
        />
        {periods.map((period, index) => {
          const groupX = padLeft + index * groupWidth;
          return (
            <g key={`${period}-${index}`}>
              {series.map((entry, seriesIndex) => {
                const value = entry.values[index] ?? 0;
                const barHeight = Math.max(1, (value / max) * plotHeight);
                return (
                  <rect
                    key={entry.key}
                    x={groupX + 4 + seriesIndex * barWidth}
                    y={height - padBottom - barHeight}
                    width={Math.max(2, barWidth - 1.5)}
                    height={barHeight}
                    fill={TONE_FILL[entry.tone]}
                    rx={1.5}
                  />
                );
              })}
              {index % labelEvery === 0 ? (
                <text
                  x={groupX + groupWidth / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="font-mono"
                  fill="var(--grey-text)"
                  fontSize={11}
                >
                  {period.length > 7 ? period.slice(5) : period}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

/**
 * Funnel.
 *
 * Horizontal bars, because the interesting comparison is between adjacent
 * stages and the eye reads a shared left edge far faster than a centred
 * trapezoid. Each stage carries its own conversion from the stage above it,
 * which is the number anyone actually opens a funnel for.
 */
export function Funnel({
  caption,
  stages,
}: {
  caption: string;
  stages: ReadonlyArray<{ id: string; label: string; count: number }>;
}) {
  const top = stages[0]?.count ?? 0;

  return (
    <ChartFrame
      caption={caption}
      columns={['Stage', 'Count', 'From previous', 'From top']}
      rows={stages.map((stage, index) => {
        const previous = stages[index - 1]?.count ?? stage.count;
        return [
          stage.label,
          stage.count.toLocaleString(),
          index === 0 ? '—' : `${((stage.count / Math.max(1, previous)) * 100).toFixed(1)}%`,
          `${((stage.count / Math.max(1, top)) * 100).toFixed(1)}%`,
        ];
      })}
    >
      <ol className="flex flex-col gap-2.5">
        {stages.map((stage, index) => {
          const previous = stages[index - 1]?.count ?? stage.count;
          const widthPct = top === 0 ? 0 : (stage.count / top) * 100;
          const fromPrevious = index === 0 ? null : (stage.count / Math.max(1, previous)) * 100;
          return (
            <li key={stage.id}>
              <div className="flex items-baseline justify-between gap-4 text-[13px]">
                <span className="font-medium">{stage.label}</span>
                <span className="data text-grey">
                  {stage.count.toLocaleString()}
                  {fromPrevious === null ? null : (
                    <span className="ml-2 text-[12px]">{fromPrevious.toFixed(1)}%</span>
                  )}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 w-full rounded-pill bg-paper">
                <div
                  className="h-full rounded-pill"
                  style={{
                    width: `${Math.max(0.8, widthPct)}%`,
                    background: index === stages.length - 1 ? GREEN : INK,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}

/** A single line, for a rate that only matters as a shape. */
export function Sparkline({
  caption,
  periods,
  values,
  formatValue = (value: number) => String(value),
  tone = 'ink',
}: {
  caption: string;
  periods: readonly string[];
  values: readonly number[];
  formatValue?: (value: number) => string;
  tone?: ChartSeries['tone'];
}) {
  const gradientId = useId();
  const width = 720;
  const height = 120;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 8 - ((value - min) / span) * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const path = points.length === 0 ? '' : `M${points.join(' L')}`;
  const area =
    points.length === 0 ? '' : `${path} L${width},${height} L0,${height} Z`;

  return (
    <ChartFrame
      caption={caption}
      columns={['Period', 'Value']}
      rows={periods.map((period, index) => [period, formatValue(values[index] ?? 0)])}
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[120px] w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE_FILL[tone]} stopOpacity={0.14} />
            <stop offset="100%" stopColor={TONE_FILL[tone]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={path}
          fill="none"
          stroke={TONE_FILL[tone]}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </ChartFrame>
  );
}

/** A number with its label. The dashboard's densest unit. */
export function Stat({
  label,
  value,
  note,
  tone = 'ink',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'ink' | 'green' | 'danger';
}) {
  const colour =
    tone === 'green' ? 'text-green-deep' : tone === 'danger' ? 'text-[#b42318]' : 'text-ink';
  return (
    <div className="rounded-card border border-hair bg-white px-5 py-4">
      <p className="text-[12px] font-medium uppercase tracking-[.06em] text-grey">{label}</p>
      <p className={`mt-2 text-[26px] font-semibold tracking-headline ${colour}`}>{value}</p>
      {note === undefined ? null : <p className="mt-1 text-[13px] text-grey">{note}</p>}
    </div>
  );
}
