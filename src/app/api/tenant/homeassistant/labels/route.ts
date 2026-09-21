// Architecture: API boundary /tenant/homeassistant/labels; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection, resolveHaCloudFirst } from '@/lib/haConnection';
import { listHaLabels } from '@/lib/haLabels';
import { logServerError } from '@/lib/serverErrorLog';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }

  let ha;
  try {
    const { haConnection } = await getUserWithHaConnection(me.id);
    ha = resolveHaCloudFirst(haConnection);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Dinodia Hub connection isn't set up yet for this home." },
      { status: 400 }
    );
  }

  try {
    const labels = await listHaLabels(ha);
    return NextResponse.json({ labels });
  } catch (err) {
    logServerError('[api/tenant/homeassistant/labels] Failed to load labels', err, { userId: me.id });
    return NextResponse.json(
      { error: 'We could not fetch labels from your Dinodia Hub right now. Please try again.' },
      { status: 502 }
    );
  }
}
