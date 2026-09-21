// Architecture: API boundary /public/rooms/request-access; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { HomeStatus, Role, RoomAccessRequestStatus } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { parseRoomQrPayload, hashRoomQrSecret, safeEqualHex } from '@/lib/roomQr';
import { createRoomAccessRequestEmails, resolveSingleHomeownerAdmin } from '@/lib/roomAccess';
import { normalizePhoneNumberE164 } from '@/lib/phoneNumber';

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }

  const obj = body as Record<string, unknown>;
  const qr = typeof obj.qr === 'string' ? obj.qr.trim() : '';
  const requestedName = typeof obj.name === 'string' ? obj.name.trim() : '';
  const requestedEmail = typeof obj.email === 'string' ? obj.email.trim() : '';
  const requestedPhoneRaw = typeof obj.phoneNumber === 'string' ? obj.phoneNumber.trim() : '';
  if (!qr || !requestedName || !requestedEmail || !requestedPhoneRaw) {
    return apiFailFromStatus(400, 'Name, email, phone number, and QR code are required.');
  }
  if (!EMAIL_REGEX.test(requestedEmail)) {
    return apiFailFromStatus(400, 'Please enter a valid email address.');
  }
  const requestedPhoneNumber = normalizePhoneNumberE164(requestedPhoneRaw);
  if (!requestedPhoneNumber) {
    return apiFailFromStatus(400, 'Please enter a valid phone number (include country code, e.g. +44...).');
  }

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
    return apiFailFromStatus(409, 'This home is not claimed yet. Ask the homeowner to set up the home first.');
  }

  try {
    await resolveSingleHomeownerAdmin(home.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Homeowner configuration error.';
    return apiFailFromStatus(409, message);
  }

  const existingTenant = await prisma.user.findFirst({
    where: {
      role: Role.TENANT,
      OR: [
        { email: { equals: requestedEmail, mode: 'insensitive' } },
        { emailPending: { equals: requestedEmail, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (existingTenant) {
    return apiFailFromStatus(409, 'This email already has a tenant account. Please login and add the area from Settings.');
  }

  const existingTenantPhone = await prisma.user.findFirst({
    where: { role: Role.TENANT, phoneNumber: requestedPhoneNumber },
    select: { id: true },
  });
  if (existingTenantPhone) {
    return apiFailFromStatus(
      409,
      'This phone number already has a tenant account. Please login and add the area from Settings.'
    );
  }

  const request = await prisma.roomAccessRequest.create({
    data: {
      hubInstallId: hub.id,
      roomId: room.id,
      homeIdSnapshot: home.id,
      requestedName,
      requestedEmail,
      requestedPhoneNumber,
      status: RoomAccessRequestStatus.PENDING,
    },
    select: { id: true },
  });

  try {
    await createRoomAccessRequestEmails({
      requestId: request.id,
      homeId: home.id,
      roomDisplayName: room.displayName,
      requestedName,
      requestedEmail,
      requestedPhoneNumber,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to send approval emails.';
    return apiFailFromStatus(400, message);
  }

  return NextResponse.json({ ok: true });
}
