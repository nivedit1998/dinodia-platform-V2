// Architecture: App Router surface src/app/admin/ui/charts/DailyCostTable.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { MetricPoint } from './HeatingTotalsCharts';

const currencyFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });

export function DailyCostTable({
  id,
  title,
  points,
  emptyLabel,
}: {
  id: string;
  title: string;
  points: MetricPoint[];
  emptyLabel?: string;
}) {
  const rows = (points ?? [])
    .filter((p) => p?.date instanceof Date && !Number.isNaN(p.date.getTime()) && Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <div data-chart-id={id} className="space-y-3 rounded-3xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{title}</p>
          <p className="text-lg font-semibold text-slate-900">Daily totals</p>
        </div>
        <div className="text-xs text-slate-500">GBP</div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-100">
        <table className="w-full text-sm text-slate-700">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Day</th>
              <th className="px-3 py-2 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date.toISOString()} className="odd:bg-white even:bg-slate-50/60">
                <td className="px-3 py-2">{row.date.toLocaleDateString('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })}</td>
                <td className="px-3 py-2 text-right">{currencyFmt.format(row.value)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-4 text-center text-slate-500">
                  {emptyLabel || 'No cost data in this range.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
