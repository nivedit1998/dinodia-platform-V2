import { createHash } from 'node:crypto';
import { historyDay } from './analyticsHistoryCalendar';

// A separate, disabled-by-default contract: existing binary daily rows and
// their readers/writers must never interpret these states as on/off.
export const MULTISTATE_ANALYTICS_VERSION = 1;
export const MULTISTATE_STATES = {
  SOCKET: { dimension: 'power', states: ['on', 'off', 'unknown'] },
  TV: { dimension: 'power', states: ['on', 'off', 'unknown'] },
  BLIND: { dimension: 'position', states: ['open', 'closed', 'partial', 'unknown'] },
  AC: { dimension: 'thermal_activity', states: ['heating', 'cooling', 'idle', 'unknown'] },
  WASHING_MACHINE: { dimension: 'cycle_activity', states: ['running', 'idle', 'finished', 'error', 'unknown'] },
} as const;

export const MULTISTATE_DAILY_KEYS = [
  'contractVersion', 'osDeviceId', 'osAreaId', 'analyticsCategory', 'dimension', 'controlId',
  'sourceGeneration', 'bindingRevision', 'analyticsIntervalId', 'analyticsPolicyVersion',
  'timezone', 'writerFrom', 'dayStartAt', 'dayEndAt', 'assignmentEpochAt', 'revision',
  'coverageStartAt', 'coverageEndAt', 'closedAt', 'durationsSeconds',
] as const;

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const dbInteger = (v: unknown): v is number => integer(v) && v <= 2_147_483_647;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(v).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

/** Structural validation only. Ingestion must separately enforce Home, device,
 * Area, private-ownership, exact source, epoch, replay and overlap authority. */
export function validMultiStateDailyPayload(p: Record<string, unknown>): boolean {
  if (!object(p) || !(exact(p, MULTISTATE_DAILY_KEYS) || exact(p, [...MULTISTATE_DAILY_KEYS, 'hourly'])) || p.contractVersion !== MULTISTATE_ANALYTICS_VERSION
    || !text(p.osDeviceId, 160) || !text(p.osAreaId, 160) || !text(p.controlId, 160)
    || !text(p.timezone, 64) || typeof p.analyticsCategory !== 'string' || !Object.hasOwn(MULTISTATE_STATES, p.analyticsCategory)
    || !dbInteger(p.sourceGeneration) || p.sourceGeneration < 1 || !dbInteger(p.bindingRevision)
    || p.bindingRevision < 1 || !dbInteger(p.revision) || p.revision < 1 || p.analyticsPolicyVersion !== 4
    || typeof p.analyticsIntervalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.analyticsIntervalId)
    || !['writerFrom', 'dayStartAt', 'dayEndAt', 'assignmentEpochAt', 'coverageStartAt', 'coverageEndAt'].every(k => date(p[k]))) return false;
  const policy = MULTISTATE_STATES[p.analyticsCategory as keyof typeof MULTISTATE_STATES];
  if (p.dimension !== policy.dimension || !object(p.durationsSeconds) || !exact(p.durationsSeconds, policy.states)
    || !Object.values(p.durationsSeconds).every(integer)) return false;
  if (p.closedAt !== null && (!date(p.closedAt) || p.closedAt !== p.dayEndAt)) return false;
  const dayStart = Date.parse(String(p.dayStartAt)), dayEnd = Date.parse(String(p.dayEndAt));
  const start = Date.parse(String(p.coverageStartAt)), end = Date.parse(String(p.coverageEndAt));
  const writerFrom = Date.parse(String(p.writerFrom)), epoch = Date.parse(String(p.assignmentEpochAt));
  try {
    const actual = historyDay(dayStart, p.timezone);
    if (actual.start !== dayStart || actual.end !== dayEnd) return false;
  } catch { return false; }
  if (writerFrom % 3_600_000 !== 0 || start < Math.max(dayStart, writerFrom, epoch) || end <= start || end > dayEnd
    || (end - start) % 1000 !== 0) return false;
  const total = Object.values(p.durationsSeconds).reduce<number>((sum, value) => sum + Number(value), 0);
  if (!Number.isSafeInteger(total) || total !== (end - start) / 1000) return false;
  if (p.hourly === undefined) return true; // compatible pre-hourly contract fixtures
  if (!Array.isArray(p.hourly) || p.hourly.length > 27) return false;
  if (!p.hourly.length) return true; // compact historical daily row
  const sums: Record<string, number> = Object.fromEntries(policy.states.map(s => [s, 0]));
  let cursor = start;
  const hours = new Set<number>();
  for (const part of p.hourly) {
    if (!object(part) || !exact(part, ['hourStartAt', 'coverageStartAt', 'coverageEndAt', 'durationsSeconds'])
      || !date(part.hourStartAt) || !date(part.coverageStartAt) || !date(part.coverageEndAt)
      || !object(part.durationsSeconds) || !exact(part.durationsSeconds, policy.states)
      || !Object.values(part.durationsSeconds).every(integer)) return false;
    const hour = Date.parse(part.hourStartAt), a = Date.parse(part.coverageStartAt), b = Date.parse(part.coverageEndAt);
    if (hour % 3_600_000 || hours.has(hour) || a !== cursor || a < hour || b > hour + 3_600_000
      || b <= a || b > end || (b - a) % 1000) return false;
    if (Object.values(part.durationsSeconds).reduce<number>((n, v) => n + Number(v), 0) !== (b - a) / 1000) return false;
    for (const state of policy.states) sums[state] += Number(part.durationsSeconds[state]);
    hours.add(hour); cursor = b;
  }
  const durations = p.durationsSeconds as Record<string, number>;
  return cursor === end && policy.states.every(state => sums[state] === durations[state]);
}

/** Stable ID uses structured encoding, avoiding delimiter collisions. */
export function multiStateDailyAggregateId(p: Record<string, unknown>): string {
  const parts = [p.contractVersion, p.osDeviceId, p.osAreaId, p.analyticsCategory, p.dimension, p.controlId,
    p.sourceGeneration, p.bindingRevision, p.analyticsIntervalId, p.assignmentEpochAt, p.writerFrom, p.dayStartAt];
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}
