// Architecture: API boundary /trigger-devices/[triggerDeviceId]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';

import { requireUserFromRequest } from '@/lib/apiGuards';
import { saveTriggerDeviceTarget } from '@/lib/triggerDevices';
import { safeLog } from '@/lib/safeLogger';

function normalize(value: string | null | undefined) {
  return (value ?? '').toString().trim();
}

function statusForError(error: Error) {
  if (/session/i.test(error.message)) return 401;
  if (/not available/i.test(error.message)) return 404;
  if (/required|choose|same device/i.test(error.message)) return 400;
  if (/longer than expected/i.test(error.message)) return 504;
  return 502;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ triggerDeviceId: string }> }
) {
  let me;
  try {
    me = await requireUserFromRequest(req);
  } catch {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  if (me.role === Role.ADMIN) {
    return NextResponse.json({ error: 'Admin dashboards are observe-only.' }, { status: 403 });
  }

  const { triggerDeviceId: rawTriggerDeviceId } = await params;
  const triggerDeviceId = normalize(rawTriggerDeviceId);
  if (!triggerDeviceId) {
    return NextResponse.json({ error: 'Trigger device is required.' }, { status: 400 });
  }

  const payload = await req.json().catch(() => ({}));
  try {
    const result = await saveTriggerDeviceTarget({
      userId: me.id,
      triggerDeviceId,
      bindingId: normalize(payload.bindingId ?? payload.binding_id) || null,
      targetDeviceId: normalize(payload.targetDeviceId ?? payload.target_device_id) || null,
      targetEntityId: normalize(payload.targetEntityId ?? payload.target_entity_id) || null,
      bindingName: normalize(payload.bindingName ?? payload.binding_name) || null,
    });
    return NextResponse.json(result ?? { ok: true });
  } catch (err) {
    const error = err instanceof Error ? err : new Error('Dinodia Hub did not respond when updating this trigger device.');
    safeLog('error', '[api/trigger-devices/:id] Failed to update trigger binding', {
      triggerDeviceId,
      error,
    });
    return NextResponse.json({ error: error.message }, { status: statusForError(error) });
  }
}
