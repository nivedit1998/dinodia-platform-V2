// Architecture: Shared platform helper src/lib/adminMonitoringHubStatus.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;
const MARKER_ENTITY_ID = '__hub_status__';
const MARKER_UNIT = 'hub';

const startOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const endOfDayUtc = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

function parseDateOnly(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const date = endOfDay ? endOfDayUtc(new Date(Date.UTC(y, m - 1, d))) : startOfDayUtc(new Date(Date.UTC(y, m - 1, d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function ensureRange(searchParams: URLSearchParams) {
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  if (rawFrom || rawTo) {
    const from = parseDateOnly(rawFrom, false);
    const to = parseDateOnly(rawTo, true);
    if (!from || !to) return { error: 'Invalid from/to date. Use YYYY-MM-DD.' } as const;
    if (to.getTime() < from.getTime()) return { error: 'from must be on or before to.' } as const;
    const spanDays = Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_DAYS) return { error: `Date range too large. Max ${MAX_DAYS} days.` } as const;
    return { from, to } as const;
  }

  const rawDays = searchParams.get('days');
  if (rawDays === 'all') {
    const to = endOfDayUtc(new Date());
    return { from: new Date(0), to } as const;
  }
  const parsed = Number.parseInt(rawDays || '', 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_DAYS) : 30;
  const to = endOfDayUtc(new Date());
  const from = startOfDayUtc(new Date(to.getTime() - (days - 1) * MS_PER_DAY));
  return { from, to } as const;
}

export async function buildAdminMonitoringHubStatus(args: {
  haConnectionId: number;
  searchParams: URLSearchParams;
}) {
  const { haConnectionId, searchParams } = args;
  let range = ensureRange(searchParams);
  if ('error' in range) {
    throw new Error(range.error);
  }

  if (searchParams.get('days') === 'all') {
    const oldest = await prisma.monitoringReading.findFirst({
      where: { haConnectionId, entityId: MARKER_ENTITY_ID, unit: MARKER_UNIT },
      orderBy: { capturedAt: 'asc' },
      select: { capturedAt: true },
    });
    range = { from: oldest ? startOfDayUtc(oldest.capturedAt) : range.to, to: range.to } as const;
  }

  const rows = await prisma.monitoringReading.findMany({
    where: {
      haConnectionId,
      entityId: MARKER_ENTITY_ID,
      unit: MARKER_UNIT,
      capturedAt: { gte: range.from, lte: range.to },
    },
    orderBy: { capturedAt: 'asc' },
    select: { capturedAt: true, hubOnline: true, state: true },
  });

  const points = rows.map((row) => {
    const hubOnline =
      row.hubOnline === true
        ? true
        : row.hubOnline === false
          ? false
          : (row.state ?? '').toLowerCase() === 'online';
    return { ts: row.capturedAt.toISOString(), hubOnline };
  });

  return {
    ok: true,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    points,
  };
}
