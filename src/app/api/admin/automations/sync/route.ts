// Architecture: API boundary /admin/automations/sync; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { apiFailPayload } from '@/lib/apiError';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { prisma } from '@/lib/prisma';

function errorResponse(message: string, status = 400) {
  return apiFailPayload(status, { error: message });
}

function normalizeAutomationId(raw: string) {
  return raw.trim().replace(/^automation\./i, '');
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return errorResponse('Your session has ended. Please sign in again.', 401);
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const trusted = toTrustedDeviceResponse(err);
    if (trusted) return trusted;
    throw err;
  }

  const admin = await prisma.user.findUnique({
    where: { id: me.id },
    select: { id: true, homeId: true },
  });
  if (!admin?.homeId) {
    return errorResponse('This account is not linked to a home.', 400);
  }

  const ownershipRows = await prisma.automationOwnership.findMany({
    where: { homeId: admin.homeId },
    select: { automationId: true, userId: true },
  });

  const normalizedRows = ownershipRows
    .map((row) => ({
      automationId: normalizeAutomationId(row.automationId),
      userId: row.userId,
    }))
    .filter((row) => row.automationId.length > 0);

  const deduped = Array.from(
    new Map(normalizedRows.map((row) => [row.automationId, row])).values()
  );

  if (deduped.length === 0) {
    return NextResponse.json({
      ok: true,
      homeId: admin.homeId,
      ownershipRows: 0,
      upserted: 0,
    });
  }

  await prisma.$transaction(
    deduped.map((row) =>
      prisma.homeAutomation.upsert({
        where: {
          homeId_automationId: {
            homeId: admin.homeId!,
            automationId: row.automationId,
          },
        },
        update: {
          createdByUserId: row.userId,
          source: 'DINODIA_UI',
        },
        create: {
          homeId: admin.homeId!,
          automationId: row.automationId,
          createdByUserId: row.userId,
          source: 'DINODIA_UI',
        },
      })
    )
  );

  return NextResponse.json({
    ok: true,
    homeId: admin.homeId,
    ownershipRows: ownershipRows.length,
    upserted: deduped.length,
  });
}
