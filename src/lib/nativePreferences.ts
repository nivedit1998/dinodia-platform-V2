import type { Prisma, MemberPreferenceKind } from '@prisma/client';
import { boundedJson, canonicalPublicId } from './nativeSchemaValidation';

export class NativePreferenceError extends Error {
  constructor(readonly code: 'PREFERENCE_INVALID' | 'MEMBERSHIP_FORBIDDEN' | 'REVISION_CONFLICT') { super(code); }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalIdSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 500 && value.every(canonicalPublicId) && new Set(value).size === value.length;
}

function documentValid(kind: MemberPreferenceKind, value: unknown): value is Record<string, unknown> {
  if (!boundedJson(value, 24 * 1024) || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.version !== 1) return false;
  if (kind === 'DASHBOARD_LAYOUT') {
    if (!exactKeys(document, ['version', 'tiles']) || !Array.isArray(document.tiles) || document.tiles.length > 500) return false;
    const ids = new Set<string>();
    return document.tiles.every((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const tile = raw as Record<string, unknown>;
      if (!exactKeys(tile, ['deviceId', 'size']) || !canonicalPublicId(tile.deviceId) || ids.has(tile.deviceId)) return false;
      if (!['COMPACT', 'STANDARD', 'LARGE'].includes(String(tile.size))) return false;
      ids.add(tile.deviceId);
      return true;
    });
  }
  if (kind === 'FILTER_STATE') return exactKeys(document, ['version', 'areaIds', 'deviceIds']) && canonicalIdSet(document.areaIds) && canonicalIdSet(document.deviceIds);
  if (kind === 'QUIET_HOURS') {
    if (!exactKeys(document, ['version', 'enabled', 'startLocalTime', 'endLocalTime', 'timeZone', 'days'])) return false;
    if (typeof document.enabled !== 'boolean' || typeof document.startLocalTime !== 'string' || typeof document.endLocalTime !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(document.startLocalTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(document.endLocalTime)
      || typeof document.timeZone !== 'string' || document.timeZone.length > 64 || !Array.isArray(document.days)
      || !document.days.every((day) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7)
      || new Set(document.days).size !== document.days.length || (document.enabled && document.days.length === 0)
      || document.startLocalTime === document.endLocalTime) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: document.timeZone }); } catch { return false; }
    return true;
  }
  return false;
}

async function assertReferencesVisible(db: Prisma.TransactionClient, input: {
  homeId: string; membershipId: string; role: string; grantedAreaIds: readonly string[]; document: Record<string, unknown>;
}) {
  const areaIds = 'areaIds' in input.document ? input.document.areaIds as string[] : [];
  const deviceIds = 'deviceIds' in input.document
    ? input.document.deviceIds as string[]
    : 'tiles' in input.document && Array.isArray(input.document.tiles)
      ? input.document.tiles.flatMap((tile) => tile && typeof tile === 'object' && 'deviceId' in tile ? [(tile as { deviceId: string }).deviceId] : [])
      : [];
  const permittedAreas = input.role === 'TENANT' ? [...input.grantedAreaIds] : undefined;
  if (areaIds.length) {
    if (permittedAreas && areaIds.some((areaId) => !permittedAreas.includes(areaId))) throw new NativePreferenceError('PREFERENCE_INVALID');
    const count = await db.area.count({ where: { id: { in: areaIds }, homeId: input.homeId, status: 'ACTIVE' } });
    if (count !== areaIds.length) throw new NativePreferenceError('PREFERENCE_INVALID');
  }
  if (deviceIds.length) {
    const count = await db.nativeDevice.count({
      where: {
        id: { in: deviceIds }, homeId: input.homeId, lifecycle: { notIn: ['RETIRED', 'REMOVED'] },
        ...(input.role === 'TENANT' ? {
          OR: [
            { managementClass: 'PROPERTY_DEVICE', assignments: { some: { validUntil: null, areaId: { in: permittedAreas }, area: { status: 'ACTIVE' } } } },
            { managementClass: 'TENANT_DEVICE', ownerMembershipId: input.membershipId, assignments: { some: { validUntil: null, areaId: { in: permittedAreas }, area: { status: 'ACTIVE' } } } },
          ],
        } : { managementClass: 'PROPERTY_DEVICE' }),
      },
    });
    if (count !== deviceIds.length) throw new NativePreferenceError('PREFERENCE_INVALID');
  }
}

/** Versioned, membership-scoped preferences use strict per-kind documents and revision CAS. */
export async function compareAndSetMemberPreference(db: Prisma.TransactionClient, input: {
  customerAccountId: string; membershipId: string; kind: MemberPreferenceKind; expectedRevision: number; document: unknown;
}) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !documentValid(input.kind, input.document)) throw new NativePreferenceError('PREFERENCE_INVALID');
  const membership = await db.homeMembership.findFirst({
    where: { id: input.membershipId, customerAccountId: input.customerAccountId, status: 'ACTIVE', customerAccount: { status: 'ACTIVE' }, home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } },
    select: { id: true, homeId: true, role: true, tenantAreaGrants: { where: { revokedAt: null }, select: { areaId: true } } },
  });
  if (!membership) throw new NativePreferenceError('MEMBERSHIP_FORBIDDEN');
  await assertReferencesVisible(db, { homeId: membership.homeId, membershipId: membership.id, role: membership.role, grantedAreaIds: membership.tenantAreaGrants.map((grant) => grant.areaId), document: input.document });
  const current = await db.memberPreferenceDocument.findUnique({ where: { membershipId_kind: { membershipId: membership.id, kind: input.kind } }, select: { id: true, revision: true } });
  if (!current) {
    if (input.expectedRevision !== 0) throw new NativePreferenceError('REVISION_CONFLICT');
    try {
      const created = await db.memberPreferenceDocument.create({ data: { membershipId: membership.id, kind: input.kind, document: input.document as Prisma.InputJsonValue, revision: 1 } });
      return { revision: created.revision, document: created.document };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new NativePreferenceError('REVISION_CONFLICT');
      throw error;
    }
  }
  if (current.revision !== input.expectedRevision) throw new NativePreferenceError('REVISION_CONFLICT');
  const updated = await db.memberPreferenceDocument.updateMany({ where: { id: current.id, revision: current.revision }, data: { document: input.document as Prisma.InputJsonValue, revision: { increment: 1 } } });
  if (updated.count !== 1) throw new NativePreferenceError('REVISION_CONFLICT');
  return db.memberPreferenceDocument.findUniqueOrThrow({ where: { id: current.id }, select: { revision: true, document: true } });
}
