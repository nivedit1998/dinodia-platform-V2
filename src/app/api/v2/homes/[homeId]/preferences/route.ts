import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { compareAndSetMemberPreference, NativePreferenceError } from '@/lib/nativePreferences';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';
const kinds = new Set(['DASHBOARD_LAYOUT', 'FILTER_STATE', 'QUIET_HOURS', 'NOTIFICATION_PREFERENCES', 'MANAGER_NOTIFICATION_ASSIGNMENT']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownerNotificationFamilies = ['hub_availability', 'permanent_device_outages', 'new_permanent_devices', 'tenant_access_requests', 'installation_updates', 'automation_activity'];
const tenantNotificationFamilies = ['hub_availability', 'permanent_device_outages_in_authorized_areas', 'own_tenant_device_outages', 'new_permanent_devices_in_authorized_areas', 'automation_failure_or_skipped_run', 'access_request_decisions'];

function mapPreferenceError(error: unknown): never {
  if (error instanceof NativePreferenceError) {
    if (error.code === 'MEMBERSHIP_FORBIDDEN') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Preferences are not available for this selected Home');
    if (error.code === 'REVISION_CONFLICT') throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Preferences changed. Refresh and retry.');
    if (error.code === 'PREFERENCE_FORBIDDEN') throw new Stage1AuthError(403, 'AUTHORIZATION_DENIED', 'This notification preference is controlled by the original homeowner');
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The preference document is invalid for this Home and role');
  }
  throw error;
}

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (!uuid.test(homeId) || selected.homeId !== homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Preferences are not available for this selected Home');
    const preferences = await prisma.memberPreferenceDocument.findMany({
      where: { membershipId: selected.membershipId }, orderBy: { kind: 'asc' },
      select: { kind: true, revision: true, document: true, updatedAt: true },
    });
    let availableNotificationFamilies = selected.role === 'TENANT' ? tenantNotificationFamilies : ownerNotificationFamilies;
    if (selected.role === 'PROPERTY_MANAGER') {
      const owner = await prisma.homeMembership.findFirst({ where: { homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } });
      const assignments = owner ? await prisma.memberPreferenceDocument.findUnique({
        where: { membershipId_kind: { membershipId: owner.id, kind: 'MANAGER_NOTIFICATION_ASSIGNMENT' } }, select: { document: true },
      }) : null;
      const rows = assignments?.document && typeof assignments.document === 'object' && 'assignments' in assignments.document
        ? (assignments.document as { assignments: Array<{ membershipId: string; enabledFamilies: string[] }> }).assignments : [];
      availableNotificationFamilies = rows.find((row) => row.membershipId === selected.membershipId)?.enabledFamilies ?? [];
    }
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId,
      membershipId: selected.membershipId,
      notificationCatalogue: { role: selected.role, availableFamilies: availableNotificationFamilies,
        mandatoryFamilies: ['support_security', 'ownership_security', 'account_removal', 'manager_automation_intervention'] },
      preferences: preferences.map((item) => ({ kind: item.kind, revision: item.revision, document: item.document, updatedAt: item.updatedAt.toISOString() })) },
    { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!uuid.test(homeId) || selected.homeId !== homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Preferences are not available for this selected Home');
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'document,expectedRevision,kind'
      || typeof body.kind !== 'string' || !kinds.has(body.kind)
      || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
      || !body.document || typeof body.document !== 'object' || Array.isArray(body.document)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A supported preference, current revision and bounded document are required');
    }
    let saved: { revision: number; document: unknown };
    try {
      saved = await serializableTransaction((tx) => compareAndSetMemberPreference(tx, {
        customerAccountId: selected.id, membershipId: selected.membershipId,
        kind: body.kind as 'DASHBOARD_LAYOUT' | 'FILTER_STATE' | 'QUIET_HOURS' | 'NOTIFICATION_PREFERENCES' | 'MANAGER_NOTIFICATION_ASSIGNMENT',
        expectedRevision: Number(body.expectedRevision), document: body.document,
      }));
    } catch (error) { mapPreferenceError(error); }
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId, membershipId: selected.membershipId,
      kind: body.kind, revision: saved.revision, document: saved.document },
    { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
