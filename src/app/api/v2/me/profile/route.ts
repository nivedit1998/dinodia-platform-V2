import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { operationDigest, targetDigest } from '@/lib/sensitiveOperationStepUp';
import { sha256 } from '@/lib/stage1Crypto';
import { validateCustomerProfileReceipt, validateCustomerProfileUpdateRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

type ProfileRow = { id: string; displayName: string; username: string; phoneNumber: string | null; email: string; emailVerifiedAt: Date | null; updatedAt: Date };

function profileReceipt(account: { id: string; displayName: string; username: string; phoneNumber: string | null; email: string; emailVerifiedAt: Date | null; updatedAt: Date }) {
  return { schemaVersion: 'dinodia.v1', ok: true, accountId: account.id, displayName: account.displayName,
    username: account.username, phoneNumber: account.phoneNumber, email: account.email,
    emailVerified: Boolean(account.emailVerifiedAt), profileRevision: account.updatedAt.toISOString() };
}

export async function GET(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const account = await prisma.customerAccount.findFirst({ where: { id: principal.id, status: 'ACTIVE', securityVersion: principal.securityVersion },
      select: { id: true, displayName: true, username: true, phoneNumber: true, email: true, emailVerifiedAt: true, updatedAt: true } });
    if (!account) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account session is no longer active');
    const receipt = profileReceipt(account);
    if (!validateCustomerProfileReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The account profile response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'displayName,expectedProfileRevision,phoneNumber,proof,username'
      || typeof body.displayName !== 'string' || !body.displayName.trim() || Array.from(body.displayName.trim()).length > 160
      || typeof body.username !== 'string' || !body.username.trim() || Array.from(body.username.trim()).length > 80
      || !(body.phoneNumber === null || typeof body.phoneNumber === 'string' && (body.phoneNumber.trim() === '' || /^[+() .0-9-]{7,40}$/.test(body.phoneNumber.trim())))
      || typeof body.expectedProfileRevision !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(body.expectedProfileRevision)
      || typeof body.proof !== 'string' || body.proof.length < 40 || body.proof.length > 8192
      || !validateCustomerProfileUpdateRequest(body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Review the profile fields and confirm the exact current account details');
    }

    const displayName = body.displayName.trim();
    const username = body.username.trim();
    const usernameNormalized = username.toLowerCase();
    const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() || null : null;
    const expectedProfileRevision = body.expectedProfileRevision;
    const operationValue = { displayName, usernameNormalized, phoneNumber, profileRevision: expectedProfileRevision };
    const digest = operationDigest({ customerAccountId: principal.id, customerSessionId: principal.sessionId,
      trustedDeviceId: principal.trustedDeviceId, operationKind: 'customer_profile_change', targetIds: [principal.id], value: operationValue });
    const nonceHash = sha256(body.proof);
    let result: ProfileRow;
    try {
      result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${principal.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "CustomerSession" WHERE "id" = ${principal.sessionId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "TrustedDevice" WHERE "id" = ${principal.trustedDeviceId}::uuid FOR UPDATE`;
        const now = new Date();
        const [account, session, device] = await Promise.all([
          tx.customerAccount.findUnique({ where: { id: principal.id }, select: { id: true, displayName: true, username: true, usernameNormalized: true, phoneNumber: true, email: true, emailVerifiedAt: true, status: true, securityVersion: true, updatedAt: true } }),
          tx.customerSession.findUnique({ where: { id: principal.sessionId }, select: { id: true, customerAccountId: true, trustedDeviceId: true, refreshTokenHash: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true, trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
          tx.trustedDevice.findUnique({ where: { id: principal.trustedDeviceId }, select: { id: true, customerAccountId: true, revokedAt: true, sessionVersion: true } }),
        ]);
        const credentialCurrent = principal.credentialKind === 'access'
          ? Boolean(principal.accessTokenHash && session?.accessTokenHash === principal.accessTokenHash && session.accessTokenExpiresAt && session.accessTokenExpiresAt > now)
          : session?.refreshTokenHash === principal.refreshTokenHash;
        if (!account || account.status !== 'ACTIVE' || account.securityVersion !== principal.securityVersion
          || account.updatedAt.toISOString() !== expectedProfileRevision
          || !session || session.customerAccountId !== principal.id || session.trustedDeviceId !== principal.trustedDeviceId
          || !credentialCurrent || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== principal.trustedDeviceSessionVersion
          || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
          || !device || device.customerAccountId !== principal.id || device.revokedAt || device.sessionVersion !== session.trustedDeviceSessionVersion) {
          throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'Your account profile or sign-in changed. Refresh before saving again.');
        }
        const consumed = await tx.stepUpAuthorization.updateMany({ where: {
          nonceHash, customerAccountId: principal.id, customerSessionId: principal.sessionId, trustedDeviceId: principal.trustedDeviceId,
          homeId: null, membershipId: null, operationKind: 'customer_profile_change', targetDigest: targetDigest([principal.id]),
          normalizedValueDigest: digest, policyRevision: account.securityVersion, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
        }, data: { consumedAt: now } });
        if (consumed.count !== 1) throw new Stage1AuthError(403, 'STEP_UP_REQUIRED', 'A fresh confirmation for these exact profile changes is required');
        const updated = await tx.customerAccount.update({ where: { id: principal.id }, data: {
          displayName, username, usernameNormalized, phoneNumber,
        }, select: { id: true, displayName: true, username: true, phoneNumber: true, email: true, emailVerifiedAt: true, updatedAt: true } });
        await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY', action: 'customer_profile_changed', targetType: 'CustomerAccount', targetId: principal.id,
          metadata: { outcome: 'completed', usernameChanged: account.usernameNormalized !== usernameNormalized, phonePresent: Boolean(phoneNumber) }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
        return updated;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'P2002') {
        throw new Stage1AuthError(409, 'customer_username_unavailable', 'Choose a username that is not already in use');
      }
      throw error;
    }
    const receipt = profileReceipt(result);
    if (!validateCustomerProfileReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The account profile response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
