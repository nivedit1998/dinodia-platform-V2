import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

const bounded = (value: string, max: number) => value.trim().length > 0 && [...value.trim()].length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const privateAliasKey = (value: string) => createHash('sha256').update(value.normalize('NFC').trim(), 'utf8').digest('hex');

export async function observeAreaSourceAlias(db: Prisma.TransactionClient, input: {
  homeId: string; areaId: string; hubInstallationId: string; protocol: string; sourceAreaId: string; now?: Date;
}) {
  const [area, hub] = await Promise.all([
    db.area.findFirst({ where: { id: input.areaId, homeId: input.homeId, status: 'ACTIVE' }, select: { id: true } }),
    db.hubInstallation.findFirst({ where: { id: input.hubInstallationId, homeId: input.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true } }),
  ]);
  if (!area || !hub || !bounded(input.protocol, 40) || !bounded(input.sourceAreaId, 160)) throw new Error('Source alias must resolve within the active home');
  const now = input.now ?? new Date();
  // The upstream identifier is only used for matching. Store a stable digest, never its raw value.
  const key = { hubInstallationId: hub.id, protocol: input.protocol.trim(), sourceAreaId: privateAliasKey(input.sourceAreaId) };
  const existing = await db.areaSourceAlias.findUnique({ where: { hubInstallationId_protocol_sourceAreaId: key } });
  if (existing && existing.areaId !== area.id) throw new Error('A protocol alias cannot be rebound to a different canonical area without an approved replacement reconciliation');
  if (existing) return db.areaSourceAlias.update({ where: { id: existing.id }, data: { lastSeenAt: now, retiredAt: null }, select: { id: true, homeId: true, areaId: true, hubInstallationId: true, firstSeenAt: true, lastSeenAt: true, retiredAt: true } });
  return db.areaSourceAlias.create({ data: { homeId: input.homeId, areaId: area.id, hubInstallationId: hub.id, protocol: key.protocol, sourceAreaId: key.sourceAreaId, firstSeenAt: now, lastSeenAt: now }, select: { id: true, homeId: true, areaId: true, hubInstallationId: true, firstSeenAt: true, lastSeenAt: true, retiredAt: true } });
}

export async function observeDeviceSourceAlias(db: Prisma.TransactionClient, input: {
  homeId: string; deviceId: string; hubInstallationId: string; protocol: string; sourceDeviceId: string; protocolIdentityHash?: string; now?: Date;
}) {
  const [device, hub] = await Promise.all([
    db.nativeDevice.findFirst({ where: { id: input.deviceId, homeId: input.homeId }, select: { id: true } }),
    db.hubInstallation.findFirst({ where: { id: input.hubInstallationId, homeId: input.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true } }),
  ]);
  if (!device || !hub || !bounded(input.protocol, 40) || !bounded(input.sourceDeviceId, 200) || (input.protocolIdentityHash && !/^[0-9a-f]{64}$/i.test(input.protocolIdentityHash))) throw new Error('Source alias must resolve within the active home');
  const now = input.now ?? new Date();
  // Keep replaceable protocol IDs out of the native database in recoverable plaintext.
  const key = { hubInstallationId: hub.id, protocol: input.protocol.trim(), sourceDeviceId: privateAliasKey(input.sourceDeviceId) };
  const existing = await db.nativeDeviceSourceAlias.findUnique({ where: { hubInstallationId_protocol_sourceDeviceId: key } });
  if (existing && (existing.deviceId !== device.id || existing.protocolIdentityHash && existing.protocolIdentityHash !== input.protocolIdentityHash)) throw new Error('A protocol alias cannot be rebound to a different canonical device without an approved replacement reconciliation');
  if (existing) return db.nativeDeviceSourceAlias.update({ where: { id: existing.id }, data: { protocolIdentityHash: input.protocolIdentityHash ?? existing.protocolIdentityHash, lastSeenAt: now, retiredAt: null }, select: { id: true, homeId: true, deviceId: true, hubInstallationId: true, protocolIdentityHash: true, firstSeenAt: true, lastSeenAt: true, retiredAt: true } });
  return db.nativeDeviceSourceAlias.create({ data: { homeId: input.homeId, deviceId: device.id, hubInstallationId: hub.id, protocol: key.protocol, sourceDeviceId: key.sourceDeviceId, protocolIdentityHash: input.protocolIdentityHash ?? null, firstSeenAt: now, lastSeenAt: now }, select: { id: true, homeId: true, deviceId: true, hubInstallationId: true, protocolIdentityHash: true, firstSeenAt: true, lastSeenAt: true, retiredAt: true } });
}
