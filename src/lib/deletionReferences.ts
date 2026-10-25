import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { HubSyncEvent } from './hubSyncEnvelope';

export function deletedTargetReference(hubInstallationId: string, kind: 'area' | 'device', osId: string) {
  const digest = createHash('sha256').update(JSON.stringify([hubInstallationId, kind, osId])).digest('hex');
  return `deleted-${kind}:${digest}`;
}
function references(hubId: string, event: HubSyncEvent) {
  const result = [];
  if (typeof event.payload.osDeviceId === 'string') result.push(deletedTargetReference(hubId, 'device', event.payload.osDeviceId));
  const area = event.payload.osAreaId ?? (event.type === 'device.upsert' ? event.payload.areaId : null);
  if (typeof area === 'string') result.push(deletedTargetReference(hubId, 'area', area));
  return result;
}
/** One indexed query per batch, never a scan of household data or one network query per sample. */
export async function suppressedSyncEvents(tx: Prisma.TransactionClient, hubId: string, events: HubSyncEvent[]) {
  const candidates = [...new Set(events.flatMap(event => references(hubId, event)))];
  if (!candidates.length) return new Set<string>();
  const fences = await tx.deletionSecurityReceipt.findMany({ where: {
    anonymousReference: { in: candidates }, actionType: 'AREA_DEVICE_ERASURE',
  }, select: { anonymousReference: true } });
  const retained = new Set(fences.map(row => row.anonymousReference));
  return new Set(events.filter(event => references(hubId, event).some(reference => retained.has(reference))).map(event => event.id));
}
