// Architecture: API boundary /admin/label-display-overrides; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { normalizeDisplayText, normalizeLookupKey } from '@/lib/displayNormalization';
import { prisma } from '@/lib/prisma';
import { getAdminLabelInventory } from '@/lib/adminConfigurationInventory';
import { isReservedOtherLabel, OTHER_LABEL_ERROR } from '@/lib/labelValidation';
import { sendAlexaAddOrUpdateReportForHaConnection } from '@/lib/alexaEvents';
import { safeLog } from '@/lib/safeLogger';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }
  const { haConnection } = await getUserWithHaConnection(me.id);
  const inventory = await getAdminLabelInventory({ haConnectionId: haConnection.id });
  return NextResponse.json({ ok: true, ...inventory });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }
  const { haConnection } = await getUserWithHaConnection(me.id);
  const body = await req.json().catch(() => ({}));
  const sourceTechnicalLabel = normalizeDisplayText(body?.sourceTechnicalLabel);
  const canonicalLabel = normalizeDisplayText(body?.canonicalLabel) || sourceTechnicalLabel;
  const displayName = normalizeDisplayText(body?.displayName);
  if (!sourceTechnicalLabel || !displayName) {
    return NextResponse.json(
      { error: 'Please include the source label and display name.' },
      { status: 400 }
    );
  }
  if (isReservedOtherLabel(sourceTechnicalLabel) || isReservedOtherLabel(displayName)) {
    return NextResponse.json(
      { error: OTHER_LABEL_ERROR },
      { status: 400 }
    );
  }
  const override = await prisma.labelDisplayOverride.upsert({
    where: {
      haConnectionId_sourceTechnicalLabel: {
        haConnectionId: haConnection.id,
        sourceTechnicalLabel,
      },
    },
    update: {
      canonicalLabel,
      displayName,
      displayKey: normalizeLookupKey(displayName),
      createdByUserId: me.id,
    },
    create: {
      haConnectionId: haConnection.id,
      sourceTechnicalLabel,
      canonicalLabel,
      displayName,
      displayKey: normalizeLookupKey(displayName),
      createdByUserId: me.id,
    },
  });
  try {
    await sendAlexaAddOrUpdateReportForHaConnection({ haConnectionId: haConnection.id });
  } catch (err) {
    safeLog('warn', '[api/admin/label-display-overrides] Failed to push Alexa AddOrUpdate after label override', {
      haConnectionId: haConnection.id,
      err,
    });
  }
  return NextResponse.json({ ok: true, override });
}

export const PATCH = POST;

export async function DELETE(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return NextResponse.json(
      { error: 'Your session has ended. Please sign in again.' },
      { status: 401 }
    );
  }
  const { haConnection } = await getUserWithHaConnection(me.id);
  await prisma.labelDisplayOverride.deleteMany({
    where: { haConnectionId: haConnection.id },
  });
  try {
    await sendAlexaAddOrUpdateReportForHaConnection({ haConnectionId: haConnection.id });
  } catch (err) {
    safeLog('warn', '[api/admin/label-display-overrides] Failed to push Alexa AddOrUpdate after label reset', {
      haConnectionId: haConnection.id,
      err,
    });
  }
  return NextResponse.json({ ok: true });
}
