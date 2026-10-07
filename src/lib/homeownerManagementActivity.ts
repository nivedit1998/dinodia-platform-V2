import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from './stage1Auth';

const ACTIONS = {
  home_floorplan_changed: ['Floorplan updated', 'Home'],
  area_display_override_changed: ['Area presentation updated', 'Area'],
  property_device_display_override_changed: ['Permanent device presentation updated', 'Permanent device'],
  tenant_area_grants_replaced: ['Tenant Area access updated', 'Tenant access'],
  home_tenant_membership_removed: ['Tenant access removed', 'Tenant access'],
  tenant_membership_self_removed: ['Tenant access ended', 'Tenant access'],
  home_property_manager_removed: ['Property manager access removed', 'Manager access'],
  membership_invitation_issued: ['Household invitation sent', 'Invitation'],
  membership_invitation_accepted: ['Household invitation accepted', 'Invitation'],
  membership_invitation_declined: ['Household invitation declined', 'Invitation'],
  room_access_requested: ['Area access requested', 'Area access'],
  room_access_request_cancelled: ['Area access request cancelled', 'Area access'],
  room_access_email_verified: ['Area access request verified', 'Area access'],
  permanent_installation_requested: ['Permanent installation requested', 'Installation request'],
  permanent_installation_work_started: ['Installation work started', 'Installation request'],
  permanent_installation_work_completed: ['Installation work completed', 'Installation request'],
  ownership_transfer_started: ['Ownership transfer started', 'Home ownership'],
  ownership_transfer_cancelled: ['Ownership transfer cancelled', 'Home ownership'],
  ownership_transfer_completed: ['Ownership transfer completed', 'Home ownership'],
} as const;

export type HomeownerManagementActivityItem = { id: string; occurredAt: string; activity: string; actor: string; target: string };
export type HomeownerManagementActivityPage = { schemaVersion: 'dinodia.v1'; ok: true; homeId: string; items: HomeownerManagementActivityItem[]; nextCursor: string | null; retentionStartAt: string; asOf: string };

export function activityRetentionStart(now: Date) {
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - 12);
  return start;
}

function encodeCursor(occurredAt: Date, id: string) {
  return Buffer.from(`${occurredAt.toISOString()}\n${id}`, 'utf8').toString('base64url');
}

export function decodeActivityCursor(value: string | null) {
  if (!value) return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The activity cursor is invalid');
  let decoded: string;
  try { decoded = Buffer.from(value, 'base64url').toString('utf8'); } catch { throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The activity cursor is invalid'); }
  const [timestamp, id, extra] = decoded.split('\n');
  const date = new Date(timestamp);
  if (extra !== undefined || Number.isNaN(date.getTime()) || date.toISOString() !== timestamp
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The activity cursor is invalid');
  }
  return { occurredAt: date, id };
}

export async function loadHomeownerManagementActivity(db: Prisma.TransactionClient | typeof import('./prisma').prisma, input: {
  homeId: string; actorAccountId: string; now?: Date; cursor?: string | null; limit?: number;
}) {
  const now = input.now ?? new Date();
  const retentionStartAt = activityRetentionStart(now);
  const cursor = decodeActivityCursor(input.cursor ?? null);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The activity page size is invalid');
  const actions = Object.keys(ACTIONS);
  const rows = await db.auditEvent.findMany({
    where: { homeId: input.homeId, action: { in: actions }, occurredAt: { gte: retentionStartAt, lte: now }, purgeAt: { gt: now },
      ...(cursor ? { OR: [{ occurredAt: { lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    select: { id: true, actorType: true, actorId: true, action: true, occurredAt: true },
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const actorIds = [...new Set(pageRows.flatMap((row) => row.actorType === 'CUSTOMER' && row.actorId ? [row.actorId] : []))];
  const currentAdministrators = actorIds.length ? await db.homeMembership.findMany({ where: {
    homeId: input.homeId, customerAccountId: { in: actorIds }, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] },
  }, select: { customerAccountId: true, role: true, customerAccount: { select: { displayName: true } } } }) : [];
  const administratorByAccount = new Map(currentAdministrators.map((row) => [row.customerAccountId, row]));
  const items = pageRows.map((row) => {
    const [activity, target] = ACTIONS[row.action as keyof typeof ACTIONS];
    const administrator = row.actorId ? administratorByAccount.get(row.actorId) : null;
    const actor = row.actorType === 'SYSTEM' ? 'Dinodia'
      : row.actorType === 'EMPLOYEE' ? 'Dinodia team'
        : row.actorId === input.actorAccountId ? 'You'
          : administrator?.customerAccount.displayName ?? 'Household member';
    return { id: row.id, occurredAt: row.occurredAt.toISOString(), activity, actor, target };
  });
  const last = hasMore ? pageRows.at(-1) : null;
  const page: HomeownerManagementActivityPage = {
    schemaVersion: 'dinodia.v1', ok: true, homeId: input.homeId, items,
    nextCursor: last ? encodeCursor(last.occurredAt, last.id) : null,
    retentionStartAt: retentionStartAt.toISOString(), asOf: now.toISOString(),
  };
  return page;
}

export function managementActivityCsv(page: HomeownerManagementActivityPage) {
  const cell = (value: string) => {
    const spreadsheetSafe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
  };
  return ['Date,Activity,Actor,Target', ...page.items.map((item) => [item.occurredAt, item.activity, item.actor, item.target].map(cell).join(','))].join('\r\n') + '\r\n';
}
