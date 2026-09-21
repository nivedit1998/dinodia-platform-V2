// Architecture: App Router surface src/app/admin/ui/charts/HeatingTotalsCharts.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import type { PointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bisector, extent } from 'd3-array';
import { scaleLinear, scaleTime } from 'd3-scale';
import { timeDay, timeMonday, timeMonth } from 'd3-time';

const chartPadding = { top: 24, right: 24, bottom: 34, left: 56 };
const palette = ['#0ea5e9', '#34c759', '#ff9500', '#af52de', '#ff3b30', '#5ac8fa', '#5856d6', '#30d158', '#ff2d55', '#ffd60a'];

export type MetricPoint = {
  date: Date;
  label: string;
  value: number;
};

export type MetricSeries = {
  id: string;
  label: string;
  color?: string;
  points: MetricPoint[];
};

const ChartEmpty = ({ label }: { label?: string }) => (
  <div className="flex h-[280px] items-center justify-center rounded-2xl border border-slate-200/70 bg-white/80 text-sm text-slate-500">
    {label || 'No readings in this range.'}
  </div>
);

function findNearestDate(points: Array<{ date: Date }>, target: Date) {
  if (points.length === 0) return null;
  const b = bisector((d: { date: Date }) => d.date).center;
  const idx = b(points, target);
  return points[Math.max(0, Math.min(points.length - 1, idx))] ?? null;
}

type Bucket = 'daily' | 'weekly' | 'monthly';

const formatBucketTick = (bucket: Bucket | undefined, date: Date) => {
  if (bucket === 'monthly') return date.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short' });
  if (bucket === 'weekly') {
    const end = new Date(date.getTime() + 6 * 86400000);
    return end.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  }
  if (bucket === 'daily') return date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric' });
  return date.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', day: 'numeric' });
};

const formatTooltipDate = (bucket: Bucket | undefined, date: Date) => {
  if (bucket === 'monthly') return date.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short' });
  if (bucket === 'weekly') {
    const end = new Date(date.getTime() + 6 * 86400000);
    return end.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  }
  if (bucket === 'daily') {
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    if (hours !== 0 || minutes !== 0) {
      return date.toLocaleString('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    return date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', day: 'numeric' });
};

export function MetricTotalsBarChart({
  id,
  title,
  unitLabel,
  points,
  bucket,
  unknownRanges,
  color = '#0ea5e9',
  height = 340,
  emptyLabel,
  formatValue,
  xTickMode = 'auto',
}: {
  id: string;
  title: string;
  unitLabel: string;
  points: MetricPoint[];
  bucket?: Bucket;
  unknownRanges?: Array<{ start: Date; end: Date }>;
  color?: string;
  height?: number;
  emptyLabel?: string;
  formatValue?: (value: number) => string;
  xTickMode?: 'auto' | 'day';
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const prepared = useMemo(
    () =>
      (points || [])
        .filter((p) => p.date instanceof Date && !Number.isNaN(p.date.getTime()) && Number.isFinite(p.value))
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    [points]
  );

  const xDomain = extent(prepared, (d) => d.date);
  const yMax = prepared.length > 0 ? Math.max(...prepared.map((d) => d.value)) : 0;
  const yDomain: [number, number] = [0, Math.max(1, yMax * 1.12)];

  const measuredWidth = width || 640;
  const innerWidth = Math.max(140, measuredWidth - chartPadding.left - chartPadding.right);
  const innerHeight = Math.max(160, height - chartPadding.top - chartPadding.bottom);

  const xScale = scaleTime().domain((xDomain as [Date, Date]) || [new Date(), new Date()]).range([0, innerWidth]);
  const yScale = scaleLinear().domain(yDomain).range([innerHeight, 0]);

  const ticksX =
    bucket === 'monthly'
      ? (timeMonth.every(1) ? xScale.ticks(timeMonth.every(1)!) : xScale.ticks(6))
      : bucket === 'weekly'
        ? (timeMonday.every(1) ? xScale.ticks(timeMonday.every(1)!) : xScale.ticks(6))
        : xTickMode === 'day'
          ? (timeDay.every(1) ? xScale.ticks(timeDay.every(1)!) : xScale.ticks(6))
          : xScale.ticks(Math.min(10, Math.max(3, prepared.length)));
  const ticksY = yScale.ticks(4);

  const activePoint = useMemo(() => {
    if (!hoverDate) return null;
    const nearest = findNearestDate(prepared.map((p) => ({ date: p.date })), hoverDate);
    if (!nearest) return null;
    return prepared.find((p) => p.date.getTime() === nearest.date.getTime()) ?? null;
  }, [hoverDate, prepared]);

  const handlePointer = (evt: PointerEvent<SVGRectElement>) => {
    if (!prepared.length) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const dateAtCursor = xScale.invert(Math.max(0, Math.min(innerWidth, x)));
    const nearest = findNearestDate(prepared.map((d) => ({ date: d.date })), dateAtCursor);
    if (nearest) setHoverDate(nearest.date);
  };

  if (prepared.length === 0) {
    return <ChartEmpty label={emptyLabel} />;
  }

  const barWidthRaw = innerWidth / Math.max(1, prepared.length);
  const barWidth = Math.max(2, Math.min(26, barWidthRaw * 0.85));

  const labelValue = (v: number) => (formatValue ? formatValue(v) : v.toFixed(1));

  return (
    <div ref={containerRef} data-chart-id={id} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          <p className="text-lg font-semibold text-slate-900">
            {activePoint ? activePoint.label : prepared[prepared.length - 1]?.label ?? ''}
          </p>
        </div>
        <div className="text-xs text-slate-500">{unitLabel}</div>
      </div>

      <div className="relative">
        <svg width={measuredWidth} height={height} className="block w-full">
          <g transform={`translate(${chartPadding.left},${chartPadding.top})`}>
            {(unknownRanges ?? []).map((r) => {
              const x0 = xScale(r.start);
              const x1 = xScale(r.end);
              const left = Math.max(0, Math.min(innerWidth, Math.min(x0, x1)));
              const right = Math.max(0, Math.min(innerWidth, Math.max(x0, x1)));
              const w = right - left;
              if (w <= 0) return null;
              return <rect key={`unknown-${r.start.toISOString()}-${r.end.toISOString()}`} x={left} y={0} width={w} height={innerHeight} fill="rgba(148,163,184,0.14)" />;
            })}

            {ticksY.map((t) => (
              <g key={`y-${t}`} transform={`translate(0,${yScale(t)})`}>
                <line x1={0} x2={innerWidth} stroke="rgba(148,163,184,0.25)" />
                <text x={-10} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[11px]">
                  {t.toFixed(0)}
                </text>
              </g>
            ))}

            {ticksX.map((t) => (
              <g key={`x-${t.toISOString()}`} transform={`translate(${xScale(t)},${innerHeight})`}>
                <line y1={0} y2={6} stroke="rgba(148,163,184,0.4)" />
                <text y={18} textAnchor="middle" className="fill-slate-400 text-[11px]">
                  {formatBucketTick(bucket, t)}
                </text>
              </g>
            ))}

            {prepared.map((p) => {
              const xCenter = xScale(p.date);
              const x = xCenter - barWidth / 2;
              const barHeight = Math.max(1, innerHeight - yScale(p.value));
              const y = innerHeight - barHeight;
              return <rect key={p.date.toISOString()} x={x} y={y} width={barWidth} height={barHeight} fill={color} opacity={0.85} rx={2} />;
            })}

            {activePoint ? (
              <line x1={xScale(activePoint.date)} x2={xScale(activePoint.date)} y1={0} y2={innerHeight} stroke="rgba(15,23,42,0.15)" />
            ) : null}

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

        {activePoint ? (
          <div className="pointer-events-none absolute right-4 top-4 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-sm">
            <div className="font-semibold text-slate-900">{activePoint.label}</div>
            <div className="mt-1">
              <span className="font-semibold">{labelValue(activePoint.value)}</span> {unitLabel}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MetricGroupedBarChart({
  id,
  title,
  unitLabel,
  series,
  bucket,
  unknownRanges,
  height = 340,
  emptyLabel,
  formatValue,
  xTickMode = 'auto',
}: {
  id: string;
  title: string;
  unitLabel: string;
  series: MetricSeries[];
  bucket?: Bucket;
  unknownRanges?: Array<{ start: Date; end: Date }>;
  height?: number;
  emptyLabel?: string;
  formatValue?: (value: number) => string;
  xTickMode?: 'auto' | 'day';
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const preparedSeries = useMemo(
    () =>
      (series || [])
        .map((s, idx) => ({
          ...s,
          color: s.color || palette[idx % palette.length],
          points: (s.points || [])
            .filter((p) => p.date instanceof Date && !Number.isNaN(p.date.getTime()) && Number.isFinite(p.value))
            .sort((a, b) => a.date.getTime() - b.date.getTime()),
        }))
        .filter((s) => s.points.length > 0),
    [series]
  );

  const allPoints = useMemo(() => preparedSeries.flatMap((s) => s.points), [preparedSeries]);
  const uniqueDates = useMemo(() => {
    const set = new Set<number>();
    for (const p of allPoints) set.add(p.date.getTime());
    return Array.from(set).sort((a, b) => a - b).map((ms) => new Date(ms));
  }, [allPoints]);

  const xDomain = extent(uniqueDates, (d) => d);
  const yMax = allPoints.length > 0 ? Math.max(...allPoints.map((p) => p.value)) : 0;
  const yDomain: [number, number] = [0, Math.max(1, yMax * 1.12)];

  const measuredWidth = width || 640;
  const innerWidth = Math.max(140, measuredWidth - chartPadding.left - chartPadding.right);
  const innerHeight = Math.max(160, height - chartPadding.top - chartPadding.bottom);

  const xScale = scaleTime().domain((xDomain as [Date, Date]) || [new Date(), new Date()]).range([0, innerWidth]);
  const yScale = scaleLinear().domain(yDomain).range([innerHeight, 0]);

  const ticksX =
    bucket === 'monthly'
      ? (timeMonth.every(1) ? xScale.ticks(timeMonth.every(1)!) : xScale.ticks(6))
      : bucket === 'weekly'
        ? (timeMonday.every(1) ? xScale.ticks(timeMonday.every(1)!) : xScale.ticks(6))
        : xTickMode === 'day'
          ? (timeDay.every(1) ? xScale.ticks(timeDay.every(1)!) : xScale.ticks(6))
          : xScale.ticks(Math.min(10, Math.max(3, uniqueDates.length)));
  const ticksY = yScale.ticks(4);

  const activeDate = useMemo(() => {
    if (!hoverDate) return null;
    const nearest = findNearestDate(uniqueDates.map((d) => ({ date: d })), hoverDate);
    return nearest?.date ?? null;
  }, [hoverDate, uniqueDates]);

  const handlePointer = (evt: PointerEvent<SVGRectElement>) => {
    if (!uniqueDates.length) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const dateAtCursor = xScale.invert(Math.max(0, Math.min(innerWidth, x)));
    const nearest = findNearestDate(uniqueDates.map((d) => ({ date: d })), dateAtCursor);
    if (nearest) setHoverDate(nearest.date);
  };

  const tooltipRows = useMemo(() => {
    if (!activeDate || preparedSeries.length === 0) return [];
    return preparedSeries
      .map((s) => {
        const point = s.points.find((p) => p.date.getTime() === activeDate.getTime()) ?? null;
        return { id: s.id, label: s.label, color: s.color!, value: point?.value ?? 0 };
      })
      .sort((a, b) => b.value - a.value);
  }, [activeDate, preparedSeries]);

  if (preparedSeries.length === 0) {
    return <ChartEmpty label={emptyLabel} />;
  }

  const groupWidthRaw = innerWidth / Math.max(1, uniqueDates.length);
  const groupWidth = Math.max(6, Math.min(42, groupWidthRaw * 0.9));
  const perSeriesWidth = Math.max(1.5, groupWidth / Math.max(1, preparedSeries.length));

  const labelValue = (v: number) => (formatValue ? formatValue(v) : v.toFixed(1));

  return (
    <div ref={containerRef} data-chart-id={id} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          <p className="text-lg font-semibold text-slate-900">
            {activeDate
              ? formatTooltipDate(bucket, activeDate)
              : uniqueDates[uniqueDates.length - 1]
                ? formatTooltipDate(bucket, uniqueDates[uniqueDates.length - 1])
                : ''}
          </p>
        </div>
        <div className="text-xs text-slate-500">{unitLabel}</div>
      </div>

	      <div className="relative">
	        <svg width={measuredWidth} height={height} className="block w-full">
	          <g transform={`translate(${chartPadding.left},${chartPadding.top})`}>
	            {(unknownRanges ?? []).map((r) => {
	              const x0 = xScale(r.start);
	              const x1 = xScale(r.end);
	              const left = Math.max(0, Math.min(innerWidth, Math.min(x0, x1)));
	              const right = Math.max(0, Math.min(innerWidth, Math.max(x0, x1)));
	              const w = right - left;
	              if (w <= 0) return null;
	              return <rect key={`unknown-${r.start.toISOString()}-${r.end.toISOString()}`} x={left} y={0} width={w} height={innerHeight} fill="rgba(148,163,184,0.14)" />;
	            })}

	            {ticksY.map((t) => (
	              <g key={`y-${t}`} transform={`translate(0,${yScale(t)})`}>
	                <line x1={0} x2={innerWidth} stroke="rgba(148,163,184,0.25)" />
	                <text x={-10} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[11px]">
                  {t.toFixed(0)}
                </text>
              </g>
            ))}

            {ticksX.map((t) => (
              <g key={`x-${t.toISOString()}`} transform={`translate(${xScale(t)},${innerHeight})`}>
                <line y1={0} y2={6} stroke="rgba(148,163,184,0.4)" />
                <text y={18} textAnchor="middle" className="fill-slate-400 text-[11px]">
                  {formatBucketTick(bucket, t)}
                </text>
              </g>
            ))}

            {uniqueDates.map((date) => {
              const xCenter = xScale(date);
              const groupLeft = xCenter - groupWidth / 2;
              return (
                <g key={date.toISOString()}>
                  {preparedSeries.map((s, idx) => {
                    const point = s.points.find((p) => p.date.getTime() === date.getTime());
                    const value = point?.value ?? 0;
                    const barHeight = Math.max(1, innerHeight - yScale(value));
                    const y = innerHeight - barHeight;
                    const x = groupLeft + idx * perSeriesWidth;
                    return (
                      <rect
                        key={`${s.id}-${date.toISOString()}`}
                        x={x}
                        y={y}
                        width={Math.max(1, perSeriesWidth - 1)}
                        height={barHeight}
                        fill={s.color}
                        opacity={0.82}
                        rx={1.5}
                      />
                    );
                  })}
                </g>
              );
            })}

            {activeDate ? (
              <line x1={xScale(activeDate)} x2={xScale(activeDate)} y1={0} y2={innerHeight} stroke="rgba(15,23,42,0.15)" />
            ) : null}

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

        {activeDate ? (
          <div className="pointer-events-none absolute right-4 top-4 max-w-[320px] rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-sm">
            <div className="font-semibold text-slate-900">{formatTooltipDate(bucket, activeDate)}</div>
            <div className="mt-1 flex flex-col gap-0.5">
              {tooltipRows.slice(0, 10).map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="font-semibold text-slate-900">
                    {labelValue(row.value)} {unitLabel}
                  </span>
                </div>
              ))}
              {tooltipRows.length > 10 ? (
                <div className="pt-1 text-[11px] text-slate-500">+{tooltipRows.length - 10} more…</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
