// Architecture: App Router surface src/app/admin/ui/charts/HeatingUsageCharts.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import type { PointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bisector, extent } from 'd3-array';
import { scaleLinear, scaleTime } from 'd3-scale';
import { timeHour } from 'd3-time';

const chartPadding = { top: 24, right: 24, bottom: 34, left: 56 };
const ON_COLOR = '#f97316';
const OFF_COLOR = '#0ea5e9';
const UNKNOWN_COLOR = '#94a3b8';

type UsagePoint = {
  date: Date;
  label: string;
  onMinutes: number | null;
  offMinutes: number | null;
  unknownMinutes?: number | null;
};

export type UsageSeries = {
  id: string;
  label: string;
  points: UsagePoint[];
};

const ChartEmpty = ({ label }: { label?: string }) => (
  <div className="flex h-[280px] items-center justify-center rounded-2xl border border-slate-200/70 bg-white/80 text-sm text-slate-500">
    {label || 'No readings in this range.'}
  </div>
);

const formatDateTime = (date: Date) =>
  date.toLocaleString('en-GB', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

function findNearestDate(points: Array<{ date: Date }>, target: Date) {
  if (points.length === 0) return null;
  const b = bisector((d: { date: Date }) => d.date).center;
  const idx = b(points, target);
  return points[Math.max(0, Math.min(points.length - 1, idx))] ?? null;
}

export function HeatingUsageStackedBarChart({
  id,
  title,
  series,
  height = 340,
  emptyLabel,
}: {
  id: string;
  title: string;
  series: UsageSeries[];
  height?: number;
  emptyLabel?: string;
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
      series
        .map((entry) => ({
          ...entry,
          points: entry.points
            .filter((p) => p.date instanceof Date && !Number.isNaN(p.date.getTime()))
            .sort((a, b) => a.date.getTime() - b.date.getTime()),
        }))
        .filter((entry) => entry.points.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label)),
    [series]
  );

  const aggregated = useMemo(() => {
    const byTs = new Map<number, { date: Date; label: string; on: number; off: number; unknown: number }>();
    for (const s of preparedSeries) {
      for (const p of s.points) {
        const ts = p.date.getTime();
        const existing = byTs.get(ts);
        const on = typeof p.onMinutes === 'number' && Number.isFinite(p.onMinutes) ? p.onMinutes : 0;
        const off = typeof p.offMinutes === 'number' && Number.isFinite(p.offMinutes) ? p.offMinutes : 0;
        const unknown =
          typeof p.unknownMinutes === 'number' && Number.isFinite(p.unknownMinutes) ? p.unknownMinutes : 0;
        if (existing) {
          existing.on += on;
          existing.off += off;
          existing.unknown += unknown;
        } else {
          byTs.set(ts, { date: p.date, label: p.label, on, off, unknown });
        }
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [preparedSeries]);

  const xDomain = extent(aggregated, (d) => d.date);
  const yMax = aggregated.length > 0 ? Math.max(...aggregated.map((d) => d.on + d.off + d.unknown)) : 0;
  const yDomain: [number, number] = [0, Math.max(10, yMax * 1.12)];

  const measuredWidth = width || 640;
  const innerWidth = Math.max(140, measuredWidth - chartPadding.left - chartPadding.right);
  const innerHeight = Math.max(160, height - chartPadding.top - chartPadding.bottom);

  const xScale = scaleTime().domain((xDomain as [Date, Date]) || [new Date(), new Date()]).range([0, innerWidth]);
  const yScale = scaleLinear().domain(yDomain).range([innerHeight, 0]);

  const ticksX = (timeHour.every(4) ? xScale.ticks(timeHour.every(4)!) : xScale.ticks(6)).slice(-12);
  const ticksY = yScale.ticks(4);

  const activePoint = useMemo(() => {
    if (!hoverDate) return null;
    const nearest = findNearestDate(aggregated.map((p) => ({ date: p.date })), hoverDate);
    if (!nearest) return null;
    return aggregated.find((p) => p.date.getTime() === nearest.date.getTime()) ?? null;
  }, [hoverDate, aggregated]);

  const handlePointer = (evt: PointerEvent<SVGRectElement>) => {
    if (!aggregated.length) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const dateAtCursor = xScale.invert(Math.max(0, Math.min(innerWidth, x)));
    const nearest = findNearestDate(aggregated.map((d) => ({ date: d.date })), dateAtCursor);
    if (nearest) setHoverDate(nearest.date);
  };

  if (preparedSeries.length === 0) {
    return <ChartEmpty label={emptyLabel} />;
  }

  const barWidthRaw = aggregated.length > 0 ? innerWidth / aggregated.length : innerWidth;
  const barWidth = Math.max(2, Math.min(18, barWidthRaw * 0.9));

  return (
    <div ref={containerRef} data-chart-id={id} className="rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          <p className="text-lg font-semibold text-slate-900">
            {activePoint ? formatDateTime(activePoint.date) : aggregated[aggregated.length - 1] ? formatDateTime(aggregated[aggregated.length - 1].date) : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ON_COLOR }} /> ON minutes
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: OFF_COLOR }} /> OFF minutes
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: UNKNOWN_COLOR }} /> UNKNOWN minutes
          </span>
        </div>
      </div>

      <div className="relative">
        <svg width={measuredWidth} height={height} className="block w-full">
          <g transform={`translate(${chartPadding.left},${chartPadding.top})`}>
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
                  {t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </text>
              </g>
            ))}

            {aggregated.map((p) => {
              const xCenter = xScale(p.date);
              const x = xCenter - barWidth / 2;
              const total = p.on + p.off + p.unknown;
              if (total <= 0) {
                return (
                  <g key={p.date.toISOString()}>
                    <rect x={x} y={innerHeight - 1} width={barWidth} height={1} fill="rgba(148,163,184,0.65)" rx={2} />
                  </g>
                );
              }
              const onHeight = innerHeight - yScale(p.on);
              const offHeight = innerHeight - yScale(p.off);
              const unknownHeight = innerHeight - yScale(p.unknown);

              const offY = innerHeight - offHeight;
              const onY = offY - onHeight;
              const unknownY = onY - unknownHeight;

              return (
                <g key={p.date.toISOString()}>
                  <rect x={x} y={offY} width={barWidth} height={offHeight} fill={OFF_COLOR} opacity={0.7} rx={2} />
                  <rect x={x} y={onY} width={barWidth} height={onHeight} fill={ON_COLOR} opacity={0.85} rx={2} />
                  <rect x={x} y={unknownY} width={barWidth} height={unknownHeight} fill={UNKNOWN_COLOR} opacity={0.55} rx={2} />
                </g>
              );
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
            <div className="font-semibold text-slate-900">{formatDateTime(activePoint.date)}</div>
            <div className="mt-1 flex flex-col gap-0.5">
              <span>
                ON: <span className="font-semibold">{activePoint.on.toFixed(1)}</span> min
              </span>
              <span>
                OFF: <span className="font-semibold">{activePoint.off.toFixed(1)}</span> min
              </span>
              <span>
                UNKNOWN: <span className="font-semibold">{activePoint.unknown.toFixed(1)}</span> min
              </span>
              <span className="text-slate-500">
                Total:{' '}
                <span className="font-semibold text-slate-700">
                  {(activePoint.on + activePoint.off + activePoint.unknown).toFixed(1)}
                </span>{' '}
                min
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
