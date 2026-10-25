import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { issueCustomerAuthChallenge } from '@/lib/customerAuthChallenges';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'challengeId,email'
      || typeof body.email !== 'string' || typeof body.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.challengeId)) {
      throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'Enter the email used to register');
    }
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new Stage1AuthError(400, 'customer_email_challenge_invalid', 'Enter a valid email address');
    await enforcePersistentRateLimit(`customer-email-resend:${sha256(email)}`, 3, 60 * 60 * 1000);
    const account = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, emailNormalized: true, emailVerifiedAt: true, pendingEmailNormalized: true, status: true } });
    const eligible = account && account.status === 'ACTIVE' && !account.emailVerifiedAt && !account.pendingEmailNormalized;
    const challenge = await issueCustomerAuthChallenge({ accountId: eligible ? account.id : null, email, purpose: 'CUSTOMER_EMAIL_VERIFY' });
    return NextResponse.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), state: 'PENDING' }, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
