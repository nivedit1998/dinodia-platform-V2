import { createHash } from 'node:crypto';
import type { HubSyncEnvelope, HubSyncEvent } from './hubSyncEnvelope';
import { canonicalSyncJson } from './hubSyncEnvelope';

export const HUB_USAGE_CLOSURE_REJECTION_ACTION = 'hub_sync_usage_bucket_closure_rejected';
export const HUB_USAGE_CLOSURE_RECOVERY_ACTION = 'hub_sync_usage_closure_recovered';
export const HUB_USAGE_CLOSURE_AUTH_ACTION = 'hub_sync_usage_closure_recovery_authorized';

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalSyncJson(value), 'utf8').digest('hex');
}

export function eligibleOpenFullHourEvent(envelope: HubSyncEnvelope, now: Date, targetEventId?: string): HubSyncEvent | null {
  const candidates = envelope.events.filter((event) => {
    if (event.type !== 'usage.bucket' || targetEventId && event.id !== targetEventId) return false;
    const payload = event.payload;
    const start = Date.parse(String(payload.bucketStart));
    const end = start + 3_600_000;
    const seconds = Number(payload.onSeconds) + Number(payload.offSeconds) + Number(payload.unknownSeconds);
    return payload.closedAt === null && Number.isFinite(start) && new Date(start).toISOString() === payload.bucketStart
      && start % 3_600_000 === 0 && end <= now.getTime()
      && Date.parse(String(payload.coverageStartAt)) === start && Date.parse(String(payload.coverageEndAt)) === end
      && [payload.onSeconds, payload.offSeconds, payload.unknownSeconds]
        .every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3600)
      && seconds === 3600;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function signedEnvelopeFingerprint(input: {
  serial: string; identityGeneration: number; envelope: HubSyncEnvelope;
}): string {
  return canonicalDigest({ serial: input.serial, identityGeneration: input.identityGeneration, ...input.envelope });
}

export function eventDigests(envelope: HubSyncEnvelope): Array<{ sequence: number; id: string; digest: string }> {
  return envelope.events.map((event) => ({ sequence: event.sequence, id: event.id, digest: canonicalDigest(event) }));
}

export function recoveryNormalizedFingerprint(input: {
  serial: string; identityGeneration: number; envelope: HubSyncEnvelope;
}, targetEventId: string): string {
  const envelope = structuredClone(input.envelope) as HubSyncEnvelope & { usageClosureRecovery?: unknown };
  delete envelope.usageClosureRecovery;
  const target = envelope.events.find((event) => event.id === targetEventId);
  if (!target || target.type !== 'usage.bucket') return '';
  target.payload.closedAt = null;
  return signedEnvelopeFingerprint({ serial: input.serial, identityGeneration: input.identityGeneration, envelope });
}
