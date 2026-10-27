import { createHash } from 'node:crypto';
import { canonicalSyncJson } from './hubSyncEnvelope';
import { reconcileNativeUsageCoverage, type NativeUsageRow } from './nativeAnalytics';
import { historyDayExpiry } from './analyticsHistoryCalendar';

export type BackfillUsage = NativeUsageRow & {
  id: string; analyticsCategory: string; controlId: string;
  sourceGeneration: number; bindingRevision: number; analyticsIntervalId: string | null; analyticsPolicyVersion: number;
};
export type BackfillTemperature = { id: string; deviceId: string; areaId: string; sourceGeneration: number;
  temperature: unknown; sourceObservedAt: Date; validUntil: Date; currentnessEndedAt: Date | null; analyticsPolicyVersion: number };
export type BackfillAssignment = { deviceId: string; areaId: string; validFrom: Date; validUntil: Date | null };
export type BackfillInterval = { id: string; deviceId: string; analyticsCategory: string; revision: number;
  sourceGeneration: number; analyticsPolicyVersion: number; validFrom: Date; validUntil: Date | null };

export function buildLegacyDays(input: { homeId: string; timezone: string; writerFrom: Date; day: { start: number; end: number };
  usage: BackfillUsage[]; temperature: BackfillTemperature[]; assignments: BackfillAssignment[]; intervals: BackfillInterval[] }) {
  const { day, writerFrom, homeId, timezone } = input;
  const limit = Math.min(day.end, writerFrom.getTime());
  const assignment = (deviceId: string, areaId: string, start: number, end: number) => input.assignments.find(a =>
    a.deviceId === deviceId && a.areaId === areaId && a.validFrom.getTime() <= start && (!a.validUntil || a.validUntil.getTime() >= end));
  const base = (deviceId: string, areaId: string, kind: string, category: 'LIGHT' | 'RADIATOR' | 'BOILER', controlId: string,
    generation: number, bindingRevision: number, intervalId: string | null, policy: number, start: number, end: number) => ({
    homeId, deviceId, areaId, kind, analyticsCategory: category, controlId, sourceGeneration: generation, bindingRevision,
    analyticsIntervalId: intervalId, analyticsPolicyVersion: policy, timezone, writerFrom, origin: 'LEGACY', revision: 1,
    dayStartAt: new Date(day.start), dayEndAt: new Date(day.end), assignmentEpochAt: new Date(start),
    closedAt: new Date(Math.min(day.end, writerFrom.getTime())),
    coverageStartAt: new Date(start), coverageEndAt: new Date(end), onSeconds: 0, offSeconds: 0, unknownSeconds: 0,
    knownMilliseconds: BigInt(0), celsiusMilliseconds: 0, minimumCelsius: null as number | null, maximumCelsius: null as number | null,
    sampleCount: 0, lastCelsius: null as number | null, lastObservedAt: null as Date | null, lastValidUntil: null as Date | null,
    payloadDigest: '', verifiedAt: new Date(), purgeAt: new Date(historyDayExpiry(day.start, timezone)),
  });
  type Row = ReturnType<typeof base>;
  const output: Row[] = [];
  const { rows, excludedDeviceHours } = reconcileNativeUsageCoverage(input.usage);
  if (excludedDeviceHours) throw new Error('legacy_usage_overlap_requires_reconciliation');
  for (const raw of rows as BackfillUsage[]) {
    if (raw.analyticsCategory !== 'LIGHT' && raw.analyticsCategory !== 'RADIATOR' && raw.analyticsCategory !== 'BOILER') throw new Error('legacy_category_invalid');
    const total = raw.onSeconds + raw.offSeconds + raw.unknownSeconds;
    const time = (value: Date | string) => value instanceof Date ? value.getTime() : Date.parse(value);
    const end = raw.coverageEndAt ? time(raw.coverageEndAt)
      : raw.closedAt ? time(raw.closedAt) : time(raw.bucketStart) + total * 1000;
    const start = raw.coverageStartAt ? time(raw.coverageStartAt) : end - total * 1000;
    if (end <= day.start || start >= limit) continue;
    // Mixed hourly totals cannot be truthfully prorated across a local midnight
    // or writer handover. Keep that Home's legacy detail, never fabricate a split.
    if (start < day.start || end > limit) throw new Error('legacy_usage_boundary_requires_detail');
    if (!assignment(raw.deviceId, raw.areaId, start, end)) throw new Error('legacy_assignment_unverified');
    const same = (r: Row) => r.kind === 'USAGE' && r.deviceId === raw.deviceId && r.areaId === raw.areaId
      && r.controlId === raw.controlId && r.sourceGeneration === raw.sourceGeneration && r.bindingRevision === raw.bindingRevision
      && r.analyticsCategory === raw.analyticsCategory && r.coverageEndAt.getTime() === start;
    const prior = output.findLast(same);
    const row = prior || base(raw.deviceId, raw.areaId, 'USAGE', raw.analyticsCategory, raw.controlId,
      raw.sourceGeneration, raw.bindingRevision, raw.analyticsIntervalId, raw.analyticsPolicyVersion, start, end);
    row.onSeconds += raw.onSeconds; row.offSeconds += raw.offSeconds; row.unknownSeconds += raw.unknownSeconds;
    row.coverageEndAt = new Date(end);
    if (!prior) output.push(row);
  }
  const grouped = new Map<string, BackfillTemperature[]>();
  for (const row of input.temperature) {
    const key = `${row.deviceId}|${row.sourceGeneration}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  for (const observations of grouped.values()) {
    const sorted = observations.sort((a, b) => a.sourceObservedAt.getTime() - b.sourceObservedAt.getTime());
    const fragments = new Map<string, Row>();
    for (let i = 0; i < sorted.length; i++) {
      const sample = sorted[i], observed = sample.sourceObservedAt.getTime();
      const a = input.assignments.find(a => a.deviceId === sample.deviceId && a.areaId === sample.areaId
        && a.validFrom.getTime() <= observed && (!a.validUntil || a.validUntil.getTime() > observed));
      if (!a) throw new Error('legacy_temperature_assignment_unverified');
      const interval = input.intervals.find(r => r.deviceId === sample.deviceId && r.analyticsCategory === 'RADIATOR'
        && r.sourceGeneration === sample.sourceGeneration && r.validFrom.getTime() <= observed && (!r.validUntil || r.validUntil.getTime() > observed));
      const end = Math.min(limit, sample.validUntil.getTime(), sample.currentnessEndedAt?.getTime() ?? Infinity,
        sorted[i + 1]?.sourceObservedAt.getTime() ?? Infinity, a.validUntil?.getTime() ?? Infinity, interval?.validUntil?.getTime() ?? Infinity);
      const start = Math.max(day.start, observed);
      if (end <= start) continue;
      const value = Number(sample.temperature);
      if (!Number.isFinite(value) || value < -50 || value > 80) throw new Error('legacy_temperature_invalid');
      const key = [sample.deviceId, sample.areaId, sample.sourceGeneration, interval?.revision || 0, a.validFrom.toISOString()].join('|');
      const row = fragments.get(key) || base(sample.deviceId, sample.areaId, 'TEMPERATURE', 'RADIATOR', 'legacy:ambient_temperature',
        sample.sourceGeneration, interval?.revision || 0, interval?.id || null, sample.analyticsPolicyVersion, start, end);
      row.knownMilliseconds += BigInt(end - start); row.celsiusMilliseconds = Math.round((row.celsiusMilliseconds + value * (end - start)) * 100) / 100;
      row.minimumCelsius = Math.min(row.minimumCelsius ?? Infinity, value); row.maximumCelsius = Math.max(row.maximumCelsius ?? -Infinity, value);
      row.sampleCount++; row.lastCelsius = value; row.lastObservedAt = sample.sourceObservedAt; row.lastValidUntil = sample.validUntil;
      row.coverageEndAt = new Date(end); fragments.set(key, row);
    }
    output.push(...fragments.values());
  }
  for (const row of output) {
    row.payloadDigest = createHash('sha256').update(canonicalSyncJson(JSON.parse(JSON.stringify({ ...row,
      verifiedAt: null, knownMilliseconds: String(row.knownMilliseconds) })))).digest('hex');
  }
  return output;
}
