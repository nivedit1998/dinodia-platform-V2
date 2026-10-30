import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/passwords';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { issueCustomerAuthChallenge } from '@/lib/customerAuthChallenges';
import { generateAvailableUsername } from '@/lib/customerUsername';

export const dynamic = 'force-dynamic';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    // The username is optional: the email-first sign-up asks only for a name and a password, and one is generated.
    const allowed = new Set(['displayName', 'username', 'email', 'password']);
    const required = ['displayName', 'email', 'password'];
    if (!record(body) || Object.keys(body).some((key) => !allowed.has(key)) || required.some((key) => !(key in body))) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Name, email and password are required');
    }
    if (![body.displayName, body.email, body.password].every((value) => typeof value === 'string') || ('username' in body && typeof body.username !== 'string')) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Name, email and password are required');
    }
    const displayName = String(body.displayName).trim();
    const chosenUsername = 'username' in body ? String(body.username).trim() : null;
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    if (!displayName || Array.from(displayName).length > 160 || (chosenUsername !== null && (!chosenUsername || Array.from(chosenUsername).length > 80))
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
      || password.length < 12 || Array.from(password).length > 1024) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Check the required account details and password length');
    }
    await enforcePersistentRateLimit(`customer-register:${sha256(email)}`, 3, 60 * 60 * 1000);
    if (chosenUsername !== null && await prisma.customerAccount.findUnique({ where: { usernameNormalized: chosenUsername.toLowerCase() }, select: { id: true } })) {
      throw new Stage1AuthError(409, 'customer_username_unavailable', 'Choose a different username');
    }
    let accountId: string | null = null;
    const existing = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } });
    if (!existing) {
      const pendingTenantInvitations = await prisma.membershipInvitation.findMany({
        where: { targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: new Date() }, temporaryCredentialHash: { not: null } },
        select: { id: true }, take: 1,
      });
      if (pendingTenantInvitations.length > 0) {
        // The linked one-time password is redeemed only by the normal sign-in
        // endpoint; this registration form cannot create a placeholder account,
        // send a second verification message or choose the tenant's username.
        throw new Stage1AuthError(400, 'customer_registration_invalid', 'Use the invitation link to sign in with the one-time password.');
      }
      const passwordHash = hashPassword(password);
      for (let attempt = 0; attempt < 4 && !accountId; attempt += 1) try {
        const username = chosenUsername ?? await generateAvailableUsername(displayName, email,
          async (normalized) => !!(await prisma.customerAccount.findUnique({ where: { usernameNormalized: normalized }, select: { id: true } })));
        const usernameNormalized = username.toLowerCase();
        const created = await prisma.customerAccount.create({ data: {
          displayName,
          username,
          usernameNormalized,
          email,
          emailNormalized: email,
          passwordHash,
          status: 'ACTIVE',
        }, select: { id: true } });
        accountId = created.id;
        await prisma.auditEvent.create({ data: {
          actorType: 'CUSTOMER', actorId: created.id, category: 'SECURITY', action: 'customer_registration_started',
          targetType: 'CustomerAccount', targetId: created.id, metadata: { outcome: 'email_verification_pending' },
          purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        } });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'P2002')) throw error;
        // Concurrent registration for the same normalized email remains an
        // indistinguishable accepted response; it never creates a second account.
        // A generated username that was taken in the meantime is simply generated again.
        if (chosenUsername !== null || await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } })) break;
      }
    }
    const challenge = await issueCustomerAuthChallenge({ accountId, email, purpose: 'CUSTOMER_EMAIL_VERIFY' });
    // Existing and newly-registered addresses receive the same response shape
    // and status. Provider acceptance is not represented as inbox delivery.
    return NextResponse.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), state: 'PENDING' }, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
