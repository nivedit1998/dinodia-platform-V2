// Architecture: API boundary /tenant/profile/change-password; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest, hashPassword, verifyPassword } from '@/lib/auth';

const MIN_PASSWORD_LENGTH = 8;

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  let body: {
    currentPassword?: string;
    newPassword?: string;
    confirmNewPassword?: string;
  };

  try {
    body = await req.json();
  } catch {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }

  const { currentPassword, newPassword, confirmNewPassword } = body ?? {};

  if (
    typeof currentPassword !== 'string' ||
    typeof newPassword !== 'string' ||
    typeof confirmNewPassword !== 'string'
  ) {
    return apiFailFromStatus(400, 'Please fill in all password fields.');
  }

  if (newPassword !== confirmNewPassword) {
    return apiFailFromStatus(400, 'New passwords do not match.');
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return apiFailFromStatus(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { passwordHash: true },
  });
  if (!user) {
    return apiFailFromStatus(404, 'User not found.');
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return apiFailFromStatus(400, 'Current password is incorrect.');
  }

  if (currentPassword === newPassword) {
    return apiFailFromStatus(400, 'New password must be different from the current password.');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: me.id },
    data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
