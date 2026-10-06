import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { issueCustomerAuthChallenge } from '@/lib/customerAuthChallenges';
import { sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'identifier' || typeof body.identifier !== 'string') {
      throw new Stage1AuthError(400, 'customer_password_recovery_invalid', 'Enter the username or email address for your account');
    }
    const identifier = body.identifier.trim().toLowerCase();
    if (!identifier || identifier.length > 320) throw new Stage1AuthError(400, 'customer_password_recovery_invalid', 'Enter the username or email address for your account');
    await enforcePersistentRateLimit(`customer-password-reset:${sha256(identifier)}`, 3, 60 * 60 * 1000);
    const account = await prisma.customerAccount.findFirst({
      where: { status: 'ACTIVE', emailVerifiedAt: { not: null }, OR: [{ emailNormalized: identifier }, { usernameNormalized: identifier }] },
      select: { id: true, email: true },
    });
    const challenge = await issueCustomerAuthChallenge({ accountId: account?.id ?? null, email: account?.email ?? 'not-deliverable@invalid.test', purpose: 'CUSTOMER_PASSWORD_RESET' });
    // The payload is identical whether a matching account exists. Provider
    // acceptance is tracked internally and is not presented as inbox delivery.
    return NextResponse.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), state: 'PENDING' }, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
