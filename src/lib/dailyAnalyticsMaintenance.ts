import type { Prisma, PrismaClient } from '@prisma/client';
import { buildLegacyDays } from './dailyAnalyticsBackfill';
import { historyDay, historyWeek, historyYearCutoff } from './analyticsHistoryCalendar';

const MAX_SOURCE_ROWS = 10000;
type Db = Prisma.TransactionClient;

/** No hidden ledger: rebuild one sealed day from real detail, then verify stored
 * exact sufficient statistics before advancing the durable resumable cursor. */
export async function backfillLegacyDay(tx: Db, hubId: string, now: Date) {
  await tx.$queryRaw`SELECT "hubInstallationId" FROM "NativeAnalyticsRetention" WHERE "hubInstallationId"=${hubId}::uuid FOR UPDATE`;
  const state = await tx.nativeAnalyticsRetention.findUniqueOrThrow({ where: { hubInstallationId: hubId } });
  if (!state.legacySealedThrough || state.legacySealedThrough.getTime() !== state.writerFrom.getTime()) return { completed: false, reason: 'legacy_barrier_pending' };
  if (state.backfillThrough && state.backfillThrough >= state.writerFrom) return { completed: true, rows: 0 };
  const minimum = historyYearCutoff(now.getTime(), state.timezone);
  const [firstUsage, firstTemperature] = state.backfillThrough ? [null, null] : await Promise.all([
    tx.nativeDeviceUsageBucket.findFirst({ where: { homeId: state.homeId, bucketStart: { gte: new Date(minimum), lt: state.writerFrom } }, orderBy: { bucketStart: 'asc' }, select: { bucketStart: true } }),
    tx.nativeTemperatureSample.findFirst({ where: { homeId: state.homeId, sourceObservedAt: { gte: new Date(minimum), lt: state.writerFrom } }, orderBy: { sourceObservedAt: 'asc' }, select: { sourceObservedAt: true } }),
  ]);
  const first = Math.min(firstUsage?.bucketStart.getTime() ?? Infinity, firstTemperature?.sourceObservedAt.getTime() ?? Infinity);
  const cursor = state.backfillThrough?.getTime() ?? (Number.isFinite(first) ? first : state.writerFrom.getTime());
  if (cursor >= state.writerFrom.getTime()) {
    await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId: hubId }, data: { backfillThrough: state.writerFrom, backfillVerifiedAt: now, backlogReason: null } });
    return { completed: true, rows: 0 };
  }
  const day = historyDay(Math.max(cursor, minimum), state.timezone), end = Math.min(day.end, state.writerFrom.getTime());
  const [usage, temperature, assignments, intervals] = await Promise.all([
    tx.nativeDeviceUsageBucket.findMany({ where: { homeId: state.homeId, bucketStart: { gte: new Date(day.start - 3600000), lt: new Date(end) },
      device: { is: { hubInstallationId: hubId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } } },
      orderBy: [{ bucketStart: 'asc' }, { id: 'asc' }], take: MAX_SOURCE_ROWS + 1 }),
    tx.nativeTemperatureSample.findMany({ where: { homeId: state.homeId, sourceObservedAt: { gte: new Date(day.start - 65595000), lt: new Date(end) },
      OR: [{ validUntil: { gt: new Date(day.start) } }, { sourceObservedAt: { gte: new Date(day.start) } }], device: { is: { hubInstallationId: hubId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } } },
      orderBy: [{ sourceObservedAt: 'asc' }, { id: 'asc' }], take: MAX_SOURCE_ROWS + 1 }),
    tx.deviceAreaAssignment.findMany({ where: { homeId: state.homeId, validFrom: { lt: new Date(end) }, OR: [{ validUntil: null }, { validUntil: { gt: new Date(day.start - 65595000) } }] }, take: MAX_SOURCE_ROWS + 1 }),
    tx.nativeAnalyticsInterval.findMany({ where: { homeId: state.homeId, hubInstallationId: hubId }, take: MAX_SOURCE_ROWS + 1 }),
  ]);
  if ([usage, temperature, assignments, intervals].some(rows => rows.length > MAX_SOURCE_ROWS)) throw new Error('daily_backfill_budget_exceeded');
  const days = buildLegacyDays({ homeId: state.homeId, timezone: state.timezone, writerFrom: state.writerFrom, day,
    usage, temperature, assignments, intervals });
  await tx.nativeAnalyticsDay.deleteMany({ where: { homeId: state.homeId, origin: 'LEGACY', dayStartAt: new Date(day.start), writerFrom: state.writerFrom,
    device: { is: { hubInstallationId: hubId } } } });
  if (days.length) await tx.nativeAnalyticsDay.createMany({ data: days.map(row => ({ ...row, verifiedAt: now })) });
  const saved = await tx.nativeAnalyticsDay.findMany({ where: { homeId: state.homeId, origin: 'LEGACY', dayStartAt: new Date(day.start), writerFrom: state.writerFrom,
    device: { is: { hubInstallationId: hubId } } }, orderBy: { id: 'asc' }, take: MAX_SOURCE_ROWS + 1 });
  if (saved.length !== days.length) throw new Error('daily_backfill_count_mismatch');
  const expected = new Map(days.map(row => [row.payloadDigest, row]));
  for (const row of saved) {
    const source = expected.get(row.payloadDigest);
    if (!source || row.onSeconds !== source.onSeconds || row.offSeconds !== source.offSeconds || row.unknownSeconds !== source.unknownSeconds
      || row.knownMilliseconds !== source.knownMilliseconds || Number(row.celsiusMilliseconds) !== source.celsiusMilliseconds
      || row.coverageStartAt.getTime() !== source.coverageStartAt.getTime() || row.coverageEndAt.getTime() !== source.coverageEndAt.getTime())
      throw new Error('daily_backfill_statistics_mismatch');
  }
  const completed = end >= state.writerFrom.getTime();
  await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId: hubId }, data: { backfillThrough: new Date(end),
    ...(completed ? { backfillVerifiedAt: now } : {}), backlogReason: null } });
  return { completed, rows: saved.length, through: new Date(end).toISOString() };
}

/** Existing daily maintenance lease is the only scheduler. Failures preserve raw
 * detail and surface a bounded reason; there is no best-effort destructive path. */
export async function maintainDailyAnalytics(db: PrismaClient, now: Date, clock = Date.now) {
  if (process.env.DINODIA_CALENDAR_ANALYTICS_ENABLED !== 'true') return { enabled: false };
  const started = clock();
  const states = await db.nativeAnalyticsRetention.findMany({ where: { writerEnabled: true },
    orderBy: [{ updatedAt: 'asc' }, { hubInstallationId: 'asc' }], take: 20 });
  const results = [];
  for (const state of states) {
    if (clock() - started > 15000) break;
    try {
      // Annual expiry is independent of conversion/compaction: an unconvertible
      // retained day must not keep expired summaries forever.
      const year = new Date(historyYearCutoff(now.getTime(), state.timezone));
      const [stateSchema] = await db.$queryRaw<Array<{available:boolean}>>`
        SELECT to_regclass('public."NativeAnalyticsStateDay"') IS NOT NULL AS available`;
      if (stateSchema?.available) {
        await db.$executeRaw`WITH doomed AS (SELECT id FROM "NativeAnalyticsStateDay"
          WHERE "homeId"=${state.homeId}::uuid AND "hubInstallationId"=${state.hubInstallationId}::uuid AND "purgeAt"<=${now}
          ORDER BY "purgeAt",id LIMIT 1000 FOR UPDATE SKIP LOCKED)
          DELETE FROM "NativeAnalyticsStateDay" d USING doomed WHERE d.id=doomed.id`;
        const week = new Date(historyWeek(now.getTime(),state.timezone).start);
        await db.$executeRaw`WITH compact AS (SELECT id FROM "NativeAnalyticsStateDay"
          WHERE "homeId"=${state.homeId}::uuid AND "hubInstallationId"=${state.hubInstallationId}::uuid
            AND "dayEndAt"<=${week} AND hourly<>'[]'::jsonb ORDER BY "dayEndAt",id LIMIT 1000 FOR UPDATE SKIP LOCKED)
          UPDATE "NativeAnalyticsStateDay" d SET hourly='[]'::jsonb FROM compact WHERE d.id=compact.id`;
      }
      const expiredDailyDeleted = await db.$executeRaw`
        WITH doomed AS (SELECT summary.id FROM "NativeAnalyticsDay" summary
          JOIN "NativeDevice" device ON device.id=summary."deviceId"
          WHERE summary."homeId"=${state.homeId}::uuid AND device."hubInstallationId"=${state.hubInstallationId}::uuid
            AND summary."dayEndAt"<=${year} ORDER BY summary."dayEndAt",summary.id LIMIT 1000 FOR UPDATE OF summary SKIP LOCKED)
        DELETE FROM "NativeAnalyticsDay" summary USING doomed WHERE summary.id=doomed.id`;
      let result;
      for (let i = 0; i < 8 && clock() - started < 15000; i++) {
        result = await db.$transaction(tx => backfillLegacyDay(tx, state.hubInstallationId, now), { timeout: 20000 });
        if (result.completed || result.reason) break;
      }
      let compaction;
      if (state.pruningEnabled && result?.completed) for (let i = 0; i < 8 && clock() - started < 15000; i++) {
        compaction = await db.$transaction(tx => compactDailyHistory(tx, state.hubInstallationId, now, { retryRetained: i === 0 }), { timeout: 20000 });
        if (compaction.completed) break;
      }
      results.push({ hubId: state.hubInstallationId, backfill: result, compaction, expiredDailyDeleted: Number(expiredDailyDeleted) });
      // Rotate bounded work fairly, including already complete installations.
      await db.nativeAnalyticsRetention.update({ where: { hubInstallationId: state.hubInstallationId }, data: { updatedAt: now } });
    } catch (error) {
      const reason = error instanceof Error && /^legacy_|^daily_/.test(error.message) ? error.message.slice(0, 120) : 'daily_backfill_failed';
      await db.nativeAnalyticsRetention.update({ where: { hubInstallationId: state.hubInstallationId }, data: { backlogReason: reason } });
      results.push({ hubId: state.hubInstallationId, error: reason });
    }
  }
  return { enabled: true, results, currentWeek: states[0] ? historyWeek(now.getTime(), states[0].timezone) : null };
}

export async function compactDailyHistory(tx: Db, hubId: string, now: Date, options: { retryRetained?: boolean } = {}) {
  await tx.$queryRaw`SELECT "hubInstallationId" FROM "NativeAnalyticsRetention" WHERE "hubInstallationId"=${hubId}::uuid FOR UPDATE`;
  const state = await tx.nativeAnalyticsRetention.findUniqueOrThrow({ where: { hubInstallationId: hubId } });
  if (!state.pruningEnabled || !state.readsEnabled || !state.backfillVerifiedAt || !state.legacySealedThrough)
    throw new Error('daily_compaction_not_verified');
  const week = historyWeek(now.getTime(), state.timezone), year = historyYearCutoff(now.getTime(), state.timezone);
  const retained = Array.isArray(state.retainedDetailDays) ? state.retainedDetailDays.filter((x): x is string => typeof x === 'string'
    && Number.isFinite(Date.parse(x)) && Date.parse(x) >= year).sort() : [];
  const [firstUsage, firstTemperature] = state.compactionCursor || state.prunedThrough ? [null, null] : await Promise.all([
    tx.nativeDeviceUsageBucket.findFirst({ where: { homeId: state.homeId, bucketStart: { gte: new Date(year), lt: new Date(week.start) } }, orderBy: { bucketStart: 'asc' }, select: { bucketStart: true } }),
    tx.nativeTemperatureSample.findFirst({ where: { homeId: state.homeId, sourceObservedAt: { gte: new Date(year), lt: new Date(week.start) } }, orderBy: { sourceObservedAt: 'asc' }, select: { sourceObservedAt: true } }),
  ]);
  const first = Math.min(firstUsage?.bucketStart.getTime() ?? Infinity, firstTemperature?.sourceObservedAt.getTime() ?? Infinity);
  const cursor = Math.max(year, options.retryRetained && retained[0] ? Date.parse(retained[0])
    : state.compactionCursor?.getTime() ?? state.prunedThrough?.getTime() ?? (Number.isFinite(first) ? first : week.start));
  if (cursor >= week.start) return { completed: true, usageDeleted: 0, temperatureDeleted: 0 };
  const day = historyDay(cursor, state.timezone);
  if (day.end > week.start) throw new Error('daily_compaction_current_week_forbidden');
  const [usage, temperature, assignments, intervals, summaries] = await Promise.all([
    tx.nativeDeviceUsageBucket.findMany({ where: { homeId: state.homeId, bucketStart: { gte: new Date(day.start - 3600000), lt: new Date(day.end) }, device: { is: { hubInstallationId: hubId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } } }, orderBy: [{ bucketStart: 'asc' }, { id: 'asc' }], take: MAX_SOURCE_ROWS + 1 }),
    tx.nativeTemperatureSample.findMany({ where: { homeId: state.homeId, sourceObservedAt: { gte: new Date(day.start - 65595000), lt: new Date(day.end) }, OR: [{ validUntil: { gt: new Date(day.start) } }, { sourceObservedAt: { gte: new Date(day.start) } }], device: { is: { hubInstallationId: hubId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } } }, orderBy: [{ sourceObservedAt: 'asc' }, { id: 'asc' }], take: MAX_SOURCE_ROWS + 1 }),
    tx.deviceAreaAssignment.findMany({ where: { homeId: state.homeId }, take: MAX_SOURCE_ROWS + 1 }),
    tx.nativeAnalyticsInterval.findMany({ where: { homeId: state.homeId, hubInstallationId: hubId }, take: MAX_SOURCE_ROWS + 1 }),
    tx.nativeAnalyticsDay.findMany({ where: { homeId: state.homeId, dayStartAt: new Date(day.start), device: { is: { hubInstallationId: hubId, managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null } } }, take: MAX_SOURCE_ROWS + 1 }),
  ]);
  if ([usage, temperature, assignments, intervals, summaries].some(rows => rows.length > MAX_SOURCE_ROWS)) throw new Error('daily_compaction_budget_exceeded');
  const reconstructed = buildLegacyDays({ homeId: state.homeId, timezone: state.timezone, writerFrom: new Date(day.end), day,
    usage, temperature, assignments, intervals });
  const mismatch = !dailyStatisticsAgree(reconstructed, summaries, assignments)
    || summaries.some(row => row.origin === 'HUB' && row.closedAt?.getTime() !== day.end);
  const nextCursor = new Date(Math.max(state.compactionCursor?.getTime() || 0, day.end));
  if (mismatch) {
    const days = [...new Set([...retained, new Date(day.start).toISOString()])].sort();
    if (days.length > 370) throw new Error('daily_compaction_exception_budget_exceeded');
    await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId: hubId }, data: {
      compactionCursor: nextCursor, retainedDetailDays: days, backlogReason: 'daily_compaction_statistics_mismatch' } });
    return { completed: false, retained: true, through: new Date(day.end).toISOString(), usageDeleted: 0, temperatureDeleted: 0 };
  }
  await tx.nativeAnalyticsDay.updateMany({ where: { id: { in: summaries.map(r => r.id) } }, data: { verifiedAt: now } });
  const remaining = retained.filter(date => Date.parse(date) !== day.start);
  const retainedSpans = remaining.map(date => { const d = historyDay(Date.parse(date), state.timezone);
    return { start: new Date(d.start).toISOString(), end: new Date(d.end).toISOString() }; });
  const usageDeleted = await tx.nativeDeviceUsageBucket.deleteMany({ where: { id: { in: usage.filter(r =>
    (r.coverageStartAt?.getTime() ?? r.bucketStart.getTime()) >= day.start
    && (r.coverageEndAt?.getTime() ?? r.bucketStart.getTime() + 3600000) <= day.end).map(r => r.id) } } });
  // Preserve a crossing observation until its bounded validity has ended in a
  // verified day, plus the newest genuine observation for the independent Home
  // temperature card. This is a tiny live cache, not a hidden year of samples.
  const temperatureDeleted = await tx.$executeRaw`
    DELETE FROM "NativeTemperatureSample" s USING "NativeDevice" d
    WHERE s."deviceId"=d.id AND s."homeId"=${state.homeId}::uuid AND d."hubInstallationId"=${hubId}::uuid
      AND d."managementClass"='PROPERTY_DEVICE' AND d."ownerMembershipId" IS NULL
      AND s."sourceObservedAt" < ${new Date(day.end)} AND s."validUntil" <= ${new Date(day.end)}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(retainedSpans)}::jsonb) held
        WHERE s."sourceObservedAt" < (held->>'end')::timestamp AND s."validUntil" > (held->>'start')::timestamp)
      AND EXISTS (SELECT 1 FROM "NativeTemperatureSample" newer WHERE newer."deviceId"=s."deviceId"
        AND newer."sourceObservedAt">s."sourceObservedAt" AND newer."sourceObservedAt"<=${now})`;
  await tx.nativeAnalyticsDay.deleteMany({ where: { homeId: state.homeId, dayEndAt: { lte: new Date(year) }, device: { is: { hubInstallationId: hubId } } } });
  await tx.nativeAnalyticsRetention.update({ where: { hubInstallationId: hubId }, data: {
    compactionCursor: nextCursor, retainedDetailDays: remaining,
    prunedThrough: new Date(Math.min(nextCursor.getTime(), remaining.length ? Date.parse(remaining[0]) : Infinity)),
    backlogReason: remaining.length ? 'daily_compaction_statistics_mismatch' : null } });
  return { completed: day.end >= week.start, usageDeleted: usageDeleted.count, temperatureDeleted: Number(temperatureDeleted), through: new Date(day.end).toISOString() };
}

type StatisticsRow = { deviceId: string; areaId: string; kind: string; analyticsCategory: string; controlId: string;
  sourceGeneration: number; bindingRevision: number; analyticsIntervalId: string | null; analyticsPolicyVersion: number;
  onSeconds: number; offSeconds: number; unknownSeconds: number; knownMilliseconds: bigint; celsiusMilliseconds: unknown;
  coverageStartAt: Date; coverageEndAt: Date; assignmentEpochAt: Date; writerFrom: Date; origin: string;
  minimumCelsius: unknown; maximumCelsius: unknown; sampleCount: number; lastCelsius: unknown;
  lastObservedAt: Date | null; lastValidUntil: Date | null };
type Assignment = { deviceId: string; areaId: string; validFrom: Date; validUntil: Date | null };

/** Verify temporal attribution AND every retained sufficient statistic, not just
 * totals. A conservative mismatch preserves original detail for that date. */
export function dailyStatisticsAgree(expected: StatisticsRow[], actual: StatisticsRow[], assignments: Assignment[]) {
  function normalize(rows: StatisticsRow[]) {
    const values = new Map<string, { totals: number[]; spans: number[][]; min: number; max: number;
      count: number; lastAt: number; lastUntil: number; last: number }>();
    for (const r of rows) {
      if (r.kind === 'TEMPERATURE' && r.knownMilliseconds === BigInt(0)) continue;
      const a = assignments.find(a => a.deviceId === r.deviceId && a.areaId === r.areaId
        && a.validFrom.getTime() <= r.coverageStartAt.getTime()
        && (!a.validUntil || a.validUntil >= r.coverageEndAt));
      if (!a || (r.origin === 'HUB' ? Math.max(Math.floor(a.validFrom.getTime() / 1000) * 1000, r.writerFrom.getTime())
        : r.coverageStartAt.getTime()) !== r.assignmentEpochAt.getTime()) return null;
      const key = [r.deviceId, r.areaId, a.validFrom.toISOString(), r.kind, r.analyticsCategory,
        r.kind === 'USAGE' ? r.controlId : 'ambient', r.sourceGeneration, r.bindingRevision,
        r.analyticsIntervalId, r.analyticsPolicyVersion].join('|');
      const v = values.get(key) || { totals: [0, 0, 0, 0, 0], spans: [], min: Infinity, max: -Infinity,
        count: 0, lastAt: -Infinity, lastUntil: -Infinity, last: 0 };
      [r.onSeconds, r.offSeconds, r.unknownSeconds, Number(r.knownMilliseconds), Number(r.celsiusMilliseconds)]
        .forEach((n, i) => { v.totals[i] += n; });
      v.spans.push([r.coverageStartAt.getTime(), r.coverageEndAt.getTime()]);
      if (r.kind === 'TEMPERATURE') {
        v.min = Math.min(v.min, Number(r.minimumCelsius)); v.max = Math.max(v.max, Number(r.maximumCelsius));
        v.count += r.sampleCount;
        const at = r.lastObservedAt?.getTime() ?? -Infinity;
        if (at >= v.lastAt) { v.lastAt = at; v.lastUntil = r.lastValidUntil?.getTime() ?? -Infinity; v.last = Number(r.lastCelsius); }
      }
      values.set(key, v);
    }
    for (const v of values.values()) {
      const merged: number[][] = [];
      for (const span of v.spans.sort((a, b) => a[0] - b[0])) {
        const prior = merged.at(-1);
        if (prior && prior[1] === span[0]) prior[1] = span[1]; else merged.push([...span]);
      }
      v.spans = merged;
    }
    return values;
  }
  const left = normalize(expected), right = normalize(actual);
  return !!left && !!right && left.size === right.size && [...left].every(([key, a]) => {
    const b = right.get(key);
    return !!b && a.totals.every((n, i) => Math.abs(n - b.totals[i]) <= (i === 4 ? 0.01 : 0))
      && JSON.stringify(a.spans) === JSON.stringify(b.spans) && a.min === b.min && a.max === b.max
      && a.count === b.count && a.lastAt === b.lastAt && a.lastUntil === b.lastUntil && a.last === b.last;
  });
}
