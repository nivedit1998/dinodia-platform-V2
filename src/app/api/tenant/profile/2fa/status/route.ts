// Architecture: API boundary /tenant/profile/2fa/status; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.TENANT) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: {
      email: true,
      emailPending: true,
      emailVerifiedAt: true,
      email2faEnabled: true,
    },
  });

  if (!user) {
    return apiFailFromStatus(404, 'User not found.');
  }

  return NextResponse.json({
    email: user.email,
    emailPending: user.emailPending,
    emailVerifiedAt: user.emailVerifiedAt,
    email2faEnabled: user.email2faEnabled,
  });
}
