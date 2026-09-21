// Architecture: App Router surface src/app/admin/ui/charts/LineAreaChart.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import type { PointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleBand, scaleLinear, scaleTime } from 'd3-scale';
import { area, line, curveMonotoneX } from 'd3-shape';
import { bisector, extent, max } from 'd3-array';
import { timeDay, timeHour, timeMonday, timeMonth } from 'd3-time';

export type TrendPoint = { date: Date; label: string; value: number };

export type LineAreaChartProps = {
  id: string;
  title: string;
  points: TrendPoint[];
  color: string;
  gradientFrom?: string;
  gradientTo?: string;
  height?: number;
  valueUnit?: string;
  emptyLabel?: string;
  formatValue?: (value: number) => string;
  variant?: 'line' | 'bar';
  forcedWidth?: number;
};

export type MultiSeriesTrend = {
  id: string;
  label: string;
  hint?: string;
  points: TrendPoint[];
  color?: string;
};

const defaultFormat = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const chartPadding = { top: 24, right: 22, bottom: 32, left: 56 };

const ChartEmpty = ({ label }: { label?: string }) => (
  <div className="flex h-[280px] items-center justify-center rounded-2xl border border-slate-200/70 bg-white/80 text-sm text-slate-500">
    {label || 'No readings in this range.'}
  </div>
);

const getGradientStops = (color: string, from?: string, to?: string) => ({
  start: from || color,
  end: to || color,
});

const palette = [
  '#0ea5e9',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff3b30',
  '#5ac8fa',
  '#5856d6',
  '#30d158',
  '#ff2d55',
  '#ffd60a',
];

type ActiveSeriesPoint = { series: MultiSeriesTrend; point: TrendPoint | null; color: string };

function findNearestPoint(points: TrendPoint[], target: Date) {
  if (points.length === 0) return null;
  const b = bisector((d: TrendPoint) => d.date).center;
  const idx = b(points, target);
  return points[Math.max(0, Math.min(points.length - 1, idx))] ?? null;
}

export function LineAreaChart({
  id,
  title,
  points,
  color,
  gradientFrom,
  gradientTo,
  height = 320,
  valueUnit,
  emptyLabel,
  formatValue = defaultFormat,
  variant = 'line',
  forcedWidth,
}: LineAreaChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current || forcedWidth) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [forcedWidth]);

  const prepared = useMemo(() => points.filter((p) => Number.isFinite(p.value) && !Number.isNaN(p.value)), [points]);

  const xDomain = extent(prepared, (d) => d.date);
  const yMax = max(prepared, (d) => d.value) ?? 0;

  // Add gentle padding so the line sits off the edges.
  const yDomain: [number, number] = [0, yMax === 0 ? 1 : yMax * 1.08];

  const gradient = getGradientStops(color, gradientFrom, gradientTo);
  const measuredWidth = forcedWidth || width || 640; // fallback while measuring to avoid zero-width render

  const innerWidth = Math.max(140, measuredWidth - chartPadding.left - chartPadding.right);
  const innerHeight = Math.max(140, height - chartPadding.top - chartPadding.bottom);

  const xScaleTime = scaleTime()
    .domain(xDomain as [Date, Date])
    .range([0, innerWidth]);
  const xScaleBand = scaleBand()
    .domain(prepared.map((p) => p.label))
    .range([0, innerWidth])
    .padding(0.2);

  const yScale = scaleLinear().domain(yDomain).range([innerHeight, 0]);

  const linePath =
    variant === 'line' && prepared.length
      ? line<TrendPoint>()
          .x((d) => xScaleTime(d.date))
          .y((d) => yScale(d.value))
          .curve(curveMonotoneX)(prepared)
      : null;

  const areaPath =
    variant === 'line' && prepared.length
      ? area<TrendPoint>()
          .x((d) => xScaleTime(d.date))
          .y0(innerHeight)
          .y1((d) => yScale(d.value))
          .curve(curveMonotoneX)(prepared)
      : null;

  const handlePointer = (evt: PointerEvent<SVGRectElement>) => {
    const rect = evt.currentTarget.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const dateAtCursor = xScaleTime.invert(Math.max(0, Math.min(innerWidth, x)));
    const b = bisector((d: TrendPoint) => d.date).center;
    const idx = b(prepared, dateAtCursor);
    setHoverIdx(Math.max(0, Math.min(prepared.length - 1, idx)));
  };

  const active = hoverIdx != null ? prepared[hoverIdx] : null;

  const tickCount = innerWidth < 420 ? 4 : Math.min(6, Math.max(3, prepared.length));
  const ticksX = variant === 'line' ? xScaleTime.ticks(tickCount) : prepared.map((p) => p.date);
  const ticksY = yScale.ticks(4);

  const barWidth = xScaleBand.bandwidth();

  return (
    <div ref={containerRef} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          {active ? (
            <p className="text-lg font-semibold text-slate-900">
              {formatValue(active.value)} {valueUnit}{' '}
              <span className="text-sm font-normal text-slate-500">{active.label}</span>
            </p>
          ) : (
            <p className="text-lg font-semibold text-slate-900">
              {formatValue(prepared[prepared.length - 1]?.value ?? 0)} {valueUnit}
            </p>
          )}
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">Interactive · Hover to inspect</div>
      </div>

      {!prepared.length ? (
        <ChartEmpty label={emptyLabel} />
      ) : (
        <svg width={measuredWidth} height={height} className="overflow-visible">
        <defs>
          <linearGradient id={`${id}-area`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={gradient.start} stopOpacity={0.18} />
            <stop offset="100%" stopColor={gradient.end} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <g transform={`translate(${chartPadding.left},${chartPadding.top})`}>
          {/* Grid lines */}
          {ticksY.map((t) => (
            <line
              key={`y-${t}`}
              x1={0}
              x2={innerWidth}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}

          {/* Area + line or bars */}
          {variant === 'line' ? (
            <>
              {areaPath && <path d={areaPath} fill={`url(#${id}-area)`} />}
              {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
            </>
          ) : (
            prepared.map((p) => {
              const x = (xScaleBand(p.label) ?? 0) + barWidth / 2;
              const barHeight = Math.max(1, innerHeight - yScale(p.value));
              const y = innerHeight - barHeight;
              return (
                <g key={p.label}>
                  <rect
                    x={x - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    rx={4}
                    fill={color}
                    fillOpacity={0.9}
                  />
                </g>
              );
            })
          )}

          {/* Active point/guide */}
          {active && (
            <g>
              <line
                x1={variant === 'line' ? xScaleTime(active.date) : (xScaleBand(active.label) ?? 0) + barWidth / 2}
                x2={variant === 'line' ? xScaleTime(active.date) : (xScaleBand(active.label) ?? 0) + barWidth / 2}
                y1={0}
                y2={innerHeight}
                stroke={color}
                strokeDasharray="3 3"
                strokeOpacity={0.5}
              />
              <circle
                cx={variant === 'line' ? xScaleTime(active.date) : (xScaleBand(active.label) ?? 0) + barWidth / 2}
                cy={yScale(active.value)}
                r={6}
                fill="white"
                stroke={color}
                strokeWidth={2}
              />
              <foreignObject
                x={Math.max(0, (variant === 'line' ? xScaleTime(active.date) : (xScaleBand(active.label) ?? 0) + barWidth / 2) - 60)}
                y={Math.max(0, yScale(active.value) - 48)}
                width={140}
                height={60}
              >
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm">
                  <div className="font-semibold text-slate-900">
                    {formatValue(active.value)} {valueUnit}
                  </div>
                  <div className="text-slate-500">{active.label}</div>
                </div>
              </foreignObject>
            </g>
          )}

          {/* X axis */}
          {ticksX.map((t, idx) => {
            const isLine = variant === 'line';
            const xPos = isLine ? xScaleTime(t as Date) : (xScaleBand(prepared[idx]?.label) ?? 0) + barWidth / 2;
            const labelText = isLine
              ? (t as Date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
              : prepared[idx]?.label || (t as Date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
            return (
              <g key={`x-${idx}`} transform={`translate(${xPos},${innerHeight})`}>
                <line y2={6} stroke="#cbd5e1" />
                <text dy="1.3em" textAnchor="middle" className="text-[11px] fill-slate-500">
                  {labelText}
                </text>
              </g>
            );
          })}

          {/* Y axis */}
          {ticksY.map((t) => (
            <g key={`y-label-${t}`} transform={`translate(0,${yScale(t)})`}>
              <text x={-12} dy="0.32em" textAnchor="end" className="text-[11px] fill-slate-500">
                {formatValue(t)}
              </text>
            </g>
          ))}

          {/* Hover capture layer */}
          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={handlePointer}
            onPointerLeave={() => setHoverIdx(null)}
          />
        </g>
        </svg>
      )}
    </div>
  );
}

export function MultiLineChart({
  id,
  title,
  series,
  height = 320,
  valueUnit,
  unknownRanges,
  emptyLabel,
  formatValue = defaultFormat,
  forcedWidth,
  xTickIntervalHours,
  xTickBucket,
  xTickLabelFormat,
}: {
  id: string;
  title: string;
  series: MultiSeriesTrend[];
  height?: number;
  valueUnit?: string;
  unknownRanges?: Array<{ start: Date; end: Date }>;
  emptyLabel?: string;
  formatValue?: (value: number) => string;
  forcedWidth?: number;
  xTickIntervalHours?: number;
  xTickBucket?: 'daily' | 'weekly' | 'monthly';
  xTickLabelFormat?: (date: Date) => string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  useEffect(() => {
    if (!containerRef.current || forcedWidth) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [forcedWidth]);

  const preparedSeries = useMemo(
    () =>
      series
        .map((s) => ({
          ...s,
          points: s.points.filter((p) => Number.isFinite(p.value) && !Number.isNaN(p.value)),
        }))
        .filter((s) => s.points.length > 0),
    [series]
  );

  const allPoints = useMemo(
    () => preparedSeries.flatMap((s) => s.points),
    [preparedSeries]
  );

  const xDomain = extent(allPoints, (d) => d.date);
  const safeDomain: [Date, Date] = [
    xDomain[0] ?? new Date(),
    xDomain[1] ?? new Date(),
  ];
  const yMax = max(allPoints, (d) => d.value) ?? 0;
  const yDomain: [number, number] = [0, yMax === 0 ? 1 : yMax * 1.08];

  const measuredWidth = forcedWidth || width || 640;
  const innerWidth = Math.max(140, measuredWidth - chartPadding.left - chartPadding.right);
  const innerHeight = Math.max(140, height - chartPadding.top - chartPadding.bottom);

  const xScaleTime = scaleTime()
    .domain(safeDomain)
    .range([0, innerWidth]);
  const yScale = scaleLinear().domain(yDomain).range([innerHeight, 0]);

  const orderedSeries = useMemo(
    () => preparedSeries.slice().sort((a, b) => a.label.localeCompare(b.label)),
    [preparedSeries]
  );

  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    orderedSeries.forEach((s, idx) => {
      map.set(s.id, s.color || palette[idx % palette.length]);
    });
    return map;
  }, [orderedSeries]);

  const allDates = useMemo(() => {
    const dates = Array.from(new Set(allPoints.map((p) => p.date.getTime()))).sort((a, b) => a - b);
    return dates.map((ms) => new Date(ms));
  }, [allPoints]);

  const handlePointer = (evt: PointerEvent<SVGRectElement>) => {
    if (!allDates.length) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const dateAtCursor = xScaleTime.invert(Math.max(0, Math.min(innerWidth, x)));
    const b = bisector((d: Date) => d.getTime()).center;
    const idx = b(allDates, dateAtCursor);
    setHoverDate(allDates[Math.max(0, Math.min(allDates.length - 1, idx))]);
  };

  const activeSeries: ActiveSeriesPoint[] = useMemo(() => {
    if (!hoverDate) return [];
    return orderedSeries.map((s) => ({
      series: s,
      point: findNearestPoint(s.points, hoverDate),
      color: colorMap.get(s.id) || palette[0],
    }));
  }, [hoverDate, orderedSeries, colorMap]);

  const tickCount = innerWidth < 420 ? 4 : Math.min(6, Math.max(3, allDates.length));
  const interval = xTickIntervalHours ? timeHour.every(xTickIntervalHours) : null;
  const ticksX = interval
    ? xScaleTime.ticks(interval)
    : xTickBucket === 'monthly'
      ? (timeMonth.every(1) ? xScaleTime.ticks(timeMonth.every(1)!) : xScaleTime.ticks(tickCount))
      : xTickBucket === 'weekly'
        ? (timeMonday.every(1) ? xScaleTime.ticks(timeMonday.every(1)!) : xScaleTime.ticks(tickCount))
        : xTickBucket === 'daily'
          ? (timeDay.every(1) ? xScaleTime.ticks(timeDay.every(1)!) : xScaleTime.ticks(tickCount))
          : xScaleTime.ticks(tickCount);
  const ticksY = yScale.ticks(4);
  const defaultHeaderLabel = (date: Date) =>
    date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' });
  const defaultTickLabel = (date: Date) =>
    date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  const timeTickLabel = (date: Date) =>
    date.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const headerLabel = xTickIntervalHours ? timeTickLabel : defaultHeaderLabel;
  const tickLabel = xTickLabelFormat ?? (xTickIntervalHours ? timeTickLabel : defaultTickLabel);

  if (preparedSeries.length === 0) {
    return (
      <div ref={containerRef} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
        </div>
        <ChartEmpty label={emptyLabel} />
      </div>
    );
  }

  return (
    <div ref={containerRef} data-chart-id={id} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          <p className="text-lg font-semibold text-slate-900">
            {hoverDate
              ? headerLabel(hoverDate)
              : allDates[allDates.length - 1]
                ? headerLabel(allDates[allDates.length - 1])
                : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
          {orderedSeries.slice(0, 6).map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorMap.get(s.id) }} />
              {s.label}
            </span>
          ))}
          {orderedSeries.length > 6 && (
            <span className="rounded-full bg-slate-100 px-2 py-1">+{orderedSeries.length - 6} more</span>
          )}
        </div>
      </div>

      <svg width={measuredWidth} height={height} className="overflow-visible">
        <g transform={`translate(${chartPadding.left},${chartPadding.top})`}>
          {(unknownRanges ?? []).map((r) => {
            const x0 = xScaleTime(r.start);
            const x1 = xScaleTime(r.end);
            const left = Math.max(0, Math.min(innerWidth, Math.min(x0, x1)));
            const right = Math.max(0, Math.min(innerWidth, Math.max(x0, x1)));
            const w = right - left;
            if (w <= 0) return null;
            return <rect key={`unknown-${r.start.toISOString()}-${r.end.toISOString()}`} x={left} y={0} width={w} height={innerHeight} fill="rgba(148,163,184,0.12)" />;
          })}

          {ticksY.map((t) => (
            <line
              key={`y-${t}`}
              x1={0}
              x2={innerWidth}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}

          {orderedSeries.map((s) => {
            const color = colorMap.get(s.id) || palette[0];
            const path =
              line<TrendPoint>()
                .x((d) => xScaleTime(d.date))
                .y((d) => yScale(d.value))
                .curve(curveMonotoneX)(s.points) ?? '';
            return (
              <path
                key={s.id}
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={2.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.95}
              />
            );
          })}

          {hoverDate && (
            <line
              x1={xScaleTime(hoverDate)}
              x2={xScaleTime(hoverDate)}
              y1={0}
              y2={innerHeight}
              stroke="#94a3b8"
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}

          {ticksX.map((t, idx) => (
            <g key={`x-${idx}`} transform={`translate(${xScaleTime(t as Date)},${innerHeight})`}>
              <line y2={6} stroke="#cbd5e1" />
              <text dy="1.3em" textAnchor="middle" className="text-[11px] fill-slate-500">
                {tickLabel(t as Date)}
              </text>
            </g>
          ))}

          {ticksY.map((t) => (
            <g key={`y-label-${t}`} transform={`translate(0,${yScale(t)})`}>
              <text x={-12} dy="0.32em" textAnchor="end" className="text-[11px] fill-slate-500">
                {formatValue(t)}
              </text>
            </g>
          ))}

          {hoverDate && activeSeries.length > 0 && (
            <foreignObject
              x={Math.max(0, xScaleTime(hoverDate) - 90)}
              y={4}
              width={200}
              height={Math.min(320, 44 + activeSeries.length * 24)}
            >
              <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-[11px] text-slate-700 shadow-sm">
                {activeSeries.map(({ series: s, point, color }) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 py-1">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="font-semibold text-slate-900">
                      {point ? `${formatValue(point.value)}${valueUnit ? ` ${valueUnit}` : ''}` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </foreignObject>
          )}

          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={handlePointer}
            onPointerLeave={() => setHoverDate(null)}
          />
        </g>
      </svg>
    </div>
  );
}
