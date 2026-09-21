// Architecture: API boundary /tenant/rooms/request-access; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { HomeStatus, Role, RoomAccessRequestStatus } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { parseRoomQrPayload, hashRoomQrSecret, safeEqualHex } from '@/lib/roomQr';
import { createRoomAccessRequestEmails, resolveSingleHomeownerAdmin } from '@/lib/roomAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const tenant = await prisma.user.findUnique({
    where: { id: me.id },
    select: { id: true, role: true, homeId: true, username: true, email: true, emailPending: true },
  });
  if (!tenant || tenant.role !== Role.TENANT || !tenant.homeId) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const obj = body as Record<string, unknown>;
  const qr = typeof obj.qr === 'string' ? obj.qr.trim() : '';
  if (!qr) return apiFailFromStatus(400, 'QR code is required.');

  const parsed = parseRoomQrPayload(qr);
  if (!parsed || parsed.version !== '1') {
    return apiFailFromStatus(400, 'Room QR code not recognized.');
  }

  const room = await prisma.room.findUnique({
    where: { id: parsed.roomId },
    select: { id: true, hubInstallId: true, displayName: true, qrSecretHash: true },
  });
  if (!room) return apiFailFromStatus(404, 'Room not found.');

  const computed = hashRoomQrSecret(parsed.token);
  if (!safeEqualHex(computed, room.qrSecretHash)) {
    return apiFailFromStatus(400, 'Room QR code not recognized.');
  }

  const hub = await prisma.hubInstall.findUnique({
    where: { id: room.hubInstallId },
    select: { id: true, home: { select: { id: true, status: true } } },
  });
  const home = hub?.home;
  if (!hub || !home) return apiFailFromStatus(400, 'This Dinodia Hub is not linked to a home yet.');
  if (home.status === HomeStatus.UNCLAIMED) {
    return apiFailFromStatus(409, 'This home is not claimed yet.');
  }
  if (home.id !== tenant.homeId) {
    return apiFailFromStatus(403, 'You are not allowed to request access for that home.');
  }

  try {
    await resolveSingleHomeownerAdmin(home.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Homeowner configuration error.';
    return apiFailFromStatus(409, message);
  }

  const requestedEmail = (tenant.emailPending || tenant.email || '').trim();
  if (!requestedEmail) {
    return apiFailFromStatus(409, 'Your email is missing. Please complete email setup first.');
  }

  const request = await prisma.roomAccessRequest.create({
    data: {
      hubInstallId: hub.id,
      roomId: room.id,
      homeIdSnapshot: home.id,
      requestedName: tenant.username,
      requestedEmail,
      tenantUserId: tenant.id,
      status: RoomAccessRequestStatus.PENDING,
    },
    select: { id: true },
  });

  try {
    await createRoomAccessRequestEmails({
      requestId: request.id,
      homeId: home.id,
      roomDisplayName: room.displayName,
      requestedName: tenant.username,
      requestedEmail,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to send approval emails.';
    return apiFailFromStatus(400, message);
  }

  return NextResponse.json({ ok: true });
}
