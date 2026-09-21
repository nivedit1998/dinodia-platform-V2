// Architecture: API boundary /tenant/devices/[deviceId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { apiConflict, apiFailFromStatus, mapUnknownToApiError } from '@/lib/apiError';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { updateTenantOwnedDevice, deleteTenantOwnedDevice } from '@/lib/tenantDeviceMutation';

export async function PATCH(req: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await context.params;
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    const userWithHa = await getUserWithHaConnection(me.id);
    const body = await req.json().catch(() => ({}));
    const device = await updateTenantOwnedDevice({
      userWithHa,
      targetId: deviceId,
      displayName: String(body?.displayName ?? ''),
      displayLabel: typeof body?.displayLabel === 'string' ? body.displayLabel : null,
      parentAreaName: typeof body?.parentAreaName === 'string' ? body.parentAreaName : null,
      selectedVirtualAreaId: typeof body?.selectedVirtualAreaId === 'string' ? body.selectedVirtualAreaId : null,
      newVirtualSubAreaName: typeof body?.newVirtualSubAreaName === 'string' ? body.newVirtualSubAreaName : null,
    });
    return NextResponse.json({ ok: true, device });
  } catch (err) {
    if (err instanceof Error && err.name === 'ConflictError') {
      return apiConflict(err.message);
    }
    const mapped = mapUnknownToApiError(err, 'Unable to update this device.', 500);
    return NextResponse.json({ ok: false, errorCode: mapped.errorCode, error: mapped.error }, { status: mapped.status });
  }
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await context.params;
  const me = await getCurrentUserFromRequest(_req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    const userWithHa = await getUserWithHaConnection(me.id);
    const result = await deleteTenantOwnedDevice({
      userWithHa,
      targetId: deviceId,
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapUnknownToApiError(err, 'Unable to delete this device.', 500);
    return NextResponse.json({ ok: false, errorCode: mapped.errorCode, error: mapped.error }, { status: mapped.status });
  }
}
