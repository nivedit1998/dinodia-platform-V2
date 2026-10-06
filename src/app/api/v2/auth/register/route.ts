import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/passwords';
import { sha256 } from '@/lib/stage1Crypto';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { issueCustomerAuthChallenge } from '@/lib/customerAuthChallenges';
import { startInvitedTenantRegistration } from '@/lib/customerInvitationRegistration';
import { validateInvitedTenantRegistrationRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (record(body) && Object.keys(body).sort().join(',') === 'email,invitationId,password') {
      const invitationRequest = { invitationId: body.invitationId, email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email, password: body.password };
      if (!validateInvitedTenantRegistrationRequest(invitationRequest)) {
        throw new Stage1AuthError(400, 'customer_registration_invalid', 'The invitation sign-in details are invalid');
      }
      const email = invitationRequest.email;
      const accountId = await startInvitedTenantRegistration({ invitationId: invitationRequest.invitationId, email, temporaryPassword: invitationRequest.password });
      const challenge = await issueCustomerAuthChallenge({ accountId, email, purpose: 'CUSTOMER_EMAIL_VERIFY' });
      return NextResponse.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), state: 'PENDING' }, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }
    const allowed = new Set(['displayName', 'username', 'email', 'password']);
    if (!record(body) || Object.keys(body).some((key) => !allowed.has(key)) || Object.keys(body).length !== allowed.size) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Name, username, email and password are required');
    }
    if (![body.displayName, body.username, body.email, body.password].every((value) => typeof value === 'string')) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Name, username, email and password are required');
    }
    const displayName = String(body.displayName).trim();
    const username = String(body.username).trim();
    const usernameNormalized = username.toLowerCase();
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    if (!displayName || Array.from(displayName).length > 160 || !username || Array.from(username).length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320
      || password.length < 12 || Array.from(password).length > 1024) {
      throw new Stage1AuthError(400, 'customer_registration_invalid', 'Check the required account details and password length');
    }
    await enforcePersistentRateLimit(`customer-register:${sha256(email)}`, 3, 60 * 60 * 1000);
    if (await prisma.customerAccount.findUnique({ where: { usernameNormalized }, select: { id: true } })) {
      throw new Stage1AuthError(409, 'customer_username_unavailable', 'Choose a different username');
    }
    let accountId: string | null = null;
    const existing = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true } });
    if (!existing) {
      const pendingTenantInvitations = await prisma.membershipInvitation.findMany({
        where: { targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: new Date() }, temporaryCredentialHash: { not: null } },
        select: { id: true }, take: 1,
      });
      // A tenant with a one-time invitation credential must use the linked
      // invitation registration path. This general form never accepts that
      // credential or lets the invitee select the final username early.
      if (pendingTenantInvitations.length === 0) {
        const passwordHash = hashPassword(password);
        try {
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
        }
      }
    }
    const challenge = await issueCustomerAuthChallenge({ accountId, email, purpose: 'CUSTOMER_EMAIL_VERIFY' });
    // Existing and newly-registered addresses receive the same response shape
    // and status. Provider acceptance is not represented as inbox delivery.
    return NextResponse.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString(), state: 'PENDING' }, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
