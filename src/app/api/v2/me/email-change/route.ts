import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { issueCustomerAuthChallenge } from '@/lib/customerAuthChallenges';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateCustomerEmailChangeReceipt } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'email,expectedProfileRevision,proof'
      || typeof body.email !== 'string' || body.email.length > 320
      || typeof body.expectedProfileRevision !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(body.expectedProfileRevision)
      || typeof body.proof !== 'string' || body.proof.length < 40 || body.proof.length > 8192) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter the new email address and confirm this exact account change');
    }
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Enter a valid email address');
    await enforcePersistentRateLimit(`customer-email-change:${customer.id}`, 5, 60 * 60 * 1000);
    const expectedProfileRevision = body.expectedProfileRevision;
    const value = { emailNormalized: email, profileRevision: expectedProfileRevision };
    const digest = operationDigest({ customerAccountId: customer.id, customerSessionId: customer.sessionId,
      trustedDeviceId: customer.trustedDeviceId, operationKind: 'customer_email_change', targetIds: [customer.id], value });
    const nonceHash = sha256(body.proof);
    const pending = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${customer.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${customer.sessionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${customer.trustedDeviceId}::uuid FOR UPDATE`;
      // Serialize simultaneous requests for the same destination even though
      // the destination is pending and therefore not yet protected by the
      // CustomerAccount.emailNormalized unique constraint.
      // Prisma cannot deserialize PostgreSQL's `void` return type. Keep the
      // lock expression in the FROM subquery and expose a stable scalar column.
      await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${email}))) AS address_lock`;
      const now = new Date();
      const [account, session, device, conflictingAccount] = await Promise.all([
        tx.customerAccount.findUnique({ where: { id: customer.id }, select: { id: true, emailNormalized: true, emailVerifiedAt: true, pendingEmailNormalized: true, status: true, securityVersion: true, updatedAt: true } }),
        tx.customerSession.findUnique({ where: { id: customer.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: customer.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
        tx.customerAccount.findFirst({ where: { id: { not: customer.id }, OR: [{ emailNormalized: email }, { pendingEmailNormalized: email }] }, select: { id: true } }),
      ]);
      const credentialCurrent = customer.credentialKind === 'access'
        ? Boolean(customer.accessTokenHash && session?.accessTokenHash === customer.accessTokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
        : session?.refreshTokenHash === customer.refreshTokenHash;
      if (!account || account.status !== 'ACTIVE' || account.securityVersion !== customer.securityVersion
        || !account.emailVerifiedAt || account.updatedAt.toISOString() !== expectedProfileRevision
        || !session || session.customerAccountId !== customer.id || session.trustedDeviceId !== customer.trustedDeviceId
        || !credentialCurrent || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== customer.trustedDeviceSessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !device || device.customerAccountId !== customer.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion) {
        throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Your account or sign-in changed. Refresh and review the current email before continuing.');
      }
      if (email === account.emailNormalized) throw new Stage1AuthError(409, 'email_change_unchanged', 'That email address is already current');
      if (email === account.pendingEmailNormalized) {
        const liveChallenge = await tx.authChallenge.findFirst({ where: { customerAccountId: account.id, purpose: 'CUSTOMER_EMAIL_CHANGE', targetEmail: email,
          consumedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } });
        if (liveChallenge) throw new Stage1AuthError(409, 'email_change_pending', 'A confirmation link is already active for this address');
      }
      if (conflictingAccount) throw new Stage1AuthError(409, 'email_change_unavailable', 'This email address cannot be used for the account');
      const consumed = await tx.stepUpAuthorization.updateMany({ where: {
        nonceHash, customerAccountId: customer.id, customerSessionId: customer.sessionId, trustedDeviceId: customer.trustedDeviceId,
        homeId: null, membershipId: null, operationKind: 'customer_email_change', targetDigest: targetDigest([customer.id]),
        normalizedValueDigest: digest, policyRevision: account.securityVersion, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
      }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw new Stage1AuthError(403, 'STEP_UP_REQUIRED', 'A fresh confirmation for this exact new email address is required');
      await tx.customerAccount.update({ where: { id: customer.id }, data: { pendingEmail: email, pendingEmailNormalized: email } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: customer.id, category: 'SECURITY', action: 'customer_email_change_requested', targetType: 'CustomerAccount', targetId: customer.id,
        metadata: { outcome: 'pending_verification', currentSessionPreserved: true }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { email };
    }, { isolationLevel: 'Serializable' });
    const challenge = await issueCustomerAuthChallenge({ accountId: customer.id, email: pending.email, purpose: 'CUSTOMER_EMAIL_CHANGE' });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, state: 'PENDING', challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(), emailSubmission: challenge.deliveryStatus };
    if (!validateCustomerEmailChangeReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The email-change receipt failed contract validation');
    return NextResponse.json(receipt, { status: 202, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
