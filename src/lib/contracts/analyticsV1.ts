export type AnalyticsActivity = 'on' | 'off' | 'unknown';
export type AnalyticsCategory = 'light' | 'radiator' | 'boiler' | 'none';
export interface ActivityEvidenceV1 {
  category: AnalyticsCategory;
  quality: 'fresh' | 'stale' | 'unknown' | 'unavailable';
  validUntil: string;
  signals: { powerOn?: unknown; brightness?: unknown; activeHeatDemand?: unknown; activeHeatProduction?: unknown };
}
export interface UsageSampleV1 { bucket: string; onMinutes: number; offMinutes: number; unknownMinutes: number }
export interface UsageBucketV1 { onMinutes: number; offMinutes: number; unknownMinutes: number }

/** Shared contract behavior: activity is based on reported physical activity and expires to Unknown. */
export function classifyActivityV1(evidence: ActivityEvidenceV1, nowMs: number): AnalyticsActivity {
  const deadline = Date.parse(evidence.validUntil);
  if (evidence.quality !== 'fresh' || !Number.isFinite(deadline) || deadline <= nowMs) return 'unknown';
  const { signals, category } = evidence;
  if (category === 'light') {
    if (signals.powerOn === true || typeof signals.brightness === 'number' && Number.isFinite(signals.brightness) && signals.brightness > 0) return 'on';
    if (signals.powerOn === false || typeof signals.brightness === 'number' && Number.isFinite(signals.brightness) && signals.brightness === 0) return 'off';
    return 'unknown';
  }
  if (category === 'radiator') return typeof signals.activeHeatDemand === 'boolean' ? signals.activeHeatDemand ? 'on' : 'off' : 'unknown';
  if (category === 'boiler') return typeof signals.activeHeatProduction === 'boolean' ? signals.activeHeatProduction ? 'on' : 'off' : 'unknown';
  return 'unknown';
}

function validSample(sample: UsageSampleV1): boolean {
  return !!sample && typeof sample.bucket === 'string' && Boolean(sample.bucket) &&
    [sample.onMinutes, sample.offMinutes, sample.unknownMinutes].every((value) => Number.isSafeInteger(value) && value >= 0);
}

/** Mirrors the checked-in V2 period calculation: mean of contributing device samples per bucket. */
export function averageContributingSamplesV1(samples: UsageSampleV1[]): Array<UsageSampleV1> {
  const buckets = new Map<string, UsageBucketV1 & { count: number }>();
  for (const sample of samples) {
    if (!validSample(sample)) throw new TypeError('Invalid analytics sample');
    const bucket = buckets.get(sample.bucket) ?? { onMinutes: 0, offMinutes: 0, unknownMinutes: 0, count: 0 };
    bucket.onMinutes += sample.onMinutes; bucket.offMinutes += sample.offMinutes; bucket.unknownMinutes += sample.unknownMinutes; bucket.count += 1;
    buckets.set(sample.bucket, bucket);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, total]) => ({
    bucket, onMinutes: Math.floor(total.onMinutes / total.count + 0.5),
    offMinutes: Math.floor(total.offMinutes / total.count + 0.5),
    unknownMinutes: Math.floor(total.unknownMinutes / total.count + 0.5),
  }));
}

/** Mirrors hourly drill-down: sum currently selected device samples in each hour. */
export function sumSelectedDevicesPerHourV1(samples: UsageSampleV1[]): Array<UsageSampleV1> {
  const totals = new Map<string, UsageBucketV1>();
  for (const sample of samples) {
    if (!validSample(sample)) throw new TypeError('Invalid analytics sample');
    const bucket = totals.get(sample.bucket) ?? { onMinutes: 0, offMinutes: 0, unknownMinutes: 0 };
    bucket.onMinutes += sample.onMinutes; bucket.offMinutes += sample.offMinutes; bucket.unknownMinutes += sample.unknownMinutes;
    totals.set(sample.bucket, bucket);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, values]) => ({ bucket, ...values }));
}

/** Mirrors the current summary card: mean of the buckets already displayed. */
export function averageDisplayedBucketsV1(buckets: UsageBucketV1[]): UsageBucketV1 {
  if (!buckets.length) return { onMinutes: 0, offMinutes: 0, unknownMinutes: 0 };
  if (buckets.some((bucket) => ![bucket.onMinutes, bucket.offMinutes, bucket.unknownMinutes].every((value) => Number.isSafeInteger(value) && value >= 0))) throw new TypeError('Invalid displayed bucket');
  const total = buckets.reduce((sum, bucket) => ({ onMinutes: sum.onMinutes + bucket.onMinutes, offMinutes: sum.offMinutes + bucket.offMinutes, unknownMinutes: sum.unknownMinutes + bucket.unknownMinutes }), { onMinutes: 0, offMinutes: 0, unknownMinutes: 0 });
  return { onMinutes: Math.floor(total.onMinutes / buckets.length + 0.5), offMinutes: Math.floor(total.offMinutes / buckets.length + 0.5), unknownMinutes: Math.floor(total.unknownMinutes / buckets.length + 0.5) };
}
