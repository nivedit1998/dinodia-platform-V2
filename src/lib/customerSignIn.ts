import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from './prisma';
import { boundedContractText, validateCustomerSessionReceipt } from './contracts/dinodiaV1';
import { Stage1AuthError } from './stage1Auth';
import { constantTimeEqual, randomSecret, sha256 } from './stage1Crypto';

export const SESSION_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1000;

export function sessionCookie(raw: string, absoluteExpiresAt: Date, now: Date): string {
  // The browser cookie may live through the absolute ceiling so successful
  // account activity can move the server-side 30-day idle deadline. The
  // server rejects an idle-expired token even while the cookie remains stored.
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  return `dinodia_customer_session=${encodeURIComponent(raw)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${maxAge}`;
}

export type SignInDevice = { deviceInstallationId: string; publicKey: string; deviceName: string; model?: string; osFamily?: string; osVersion?: string };

/** The thumbprint a phone's signing key is trusted by; also what a two-step challenge is tied to. */
export function deviceThumbprint(publicKey: string): string {
  try { return crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex'); }
  catch { throw new Stage1AuthError(400, 'trusted_device_key_invalid', 'The trusted-device public key is invalid'); }
}

/**
 * Everything after the account has proved itself (password, and the emailed code when two-step verification applies):
 * trust or refresh the phone, create the session and its cookie. One place, so the password step and the code step cannot drift.
 */
export async function finishCustomerSignIn(account: { id: string; securityVersion: number }, input: SignInDevice): Promise<NextResponse> {
  const { deviceInstallationId, publicKey } = input;
  const deviceName = input.deviceName.trim();
  const thumbprint = deviceThumbprint(publicKey);
  const rawSession = `dno-customer-session-${randomSecret(32)}`;
  const session = await prisma.$transaction(async (tx) => {
    const existing = await tx.trustedDevice.findUnique({ where: { customerAccountId_deviceInstallationId: { customerAccountId: account.id, deviceInstallationId } }, select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true } });
    if (existing?.revokedAt) throw new Stage1AuthError(403, 'trusted_device_revoked', 'This trusted device was removed; use the approved re-enrolment process');
    if (existing && !constantTimeEqual(existing.publicKeyThumbprint, thumbprint)) throw new Stage1AuthError(409, 'trusted_device_identity_changed', 'This installation ID is already bound to another signing key');
    const trusted = existing
      ? await tx.trustedDevice.update({
        where: { id: existing.id },
        // Ordinary sign-in refreshes this device's use time only. It does not
        // rotate its revocation generation or silently invalidate its other
        // account sessions. Re-enrolment/key changes have a separate flow.
        data: { deviceName, model: boundedContractText(input.model, 160) || null, osFamily: boundedContractText(input.osFamily, 80) || null, osVersion: boundedContractText(input.osVersion, 80) || null, lastUsedAt: new Date() },
        select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true },
      })
      : await tx.trustedDevice.create({
        data: { customerAccountId: account.id, deviceInstallationId, publicKey, publicKeyThumbprint: thumbprint, deviceName, model: boundedContractText(input.model, 160) || null, osFamily: boundedContractText(input.osFamily, 80) || null, osVersion: boundedContractText(input.osVersion, 80) || null },
        select: { id: true, sessionVersion: true, revokedAt: true, publicKeyThumbprint: true },
      });
    if (trusted.revokedAt) throw new Stage1AuthError(403, 'trusted_device_revoked', 'This trusted device was removed; use the approved re-enrolment process');
    if (!constantTimeEqual(trusted.publicKeyThumbprint, thumbprint)) throw new Stage1AuthError(409, 'trusted_device_identity_changed', 'This installation ID is already bound to another signing key');
    const issuedAt = new Date();
    const absoluteExpiresAt = new Date(issuedAt.getTime() + SESSION_ABSOLUTE_MS);
    const expiresAt = new Date(Math.min(issuedAt.getTime() + SESSION_INACTIVITY_MS, absoluteExpiresAt.getTime()));
    const created = await tx.customerSession.create({ data: { customerAccountId: account.id, trustedDeviceId: trusted.id, sessionFamilyId: crypto.randomUUID(), refreshTokenHash: sha256(rawSession), securityVersion: account.securityVersion, trustedDeviceSessionVersion: trusted.sessionVersion, issuedAt, expiresAt, absoluteExpiresAt }, select: { id: true, expiresAt: true, absoluteExpiresAt: true } });
    await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_login_succeeded', targetType: 'CustomerSession', targetId: created.id, metadata: { trustedDeviceId: trusted.id, outcome: 'succeeded' }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
    return { ...created, trustedDeviceId: trusted.id };
  });
  const receipt = { ok: true, accountId: account.id, sessionId: session.id, trustedDeviceId: session.trustedDeviceId, expiresAt: session.expiresAt.toISOString() };
  if (!validateCustomerSessionReceipt(receipt)) {
    throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The customer session receipt failed contract validation');
  }
  const response = NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  response.headers.append('Set-Cookie', sessionCookie(rawSession, session.absoluteExpiresAt, new Date()));
  return response;

}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max;

/** The body of "here is my code": the challenge, its secret, the code and the same phone details the password step used. */
export function parseMfaVerifyBody(body: unknown): { challengeId: string; clientSecret: string; code: string; device: SignInDevice } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = new Set(['challengeId', 'clientSecret', 'code', 'deviceInstallationId', 'publicKey', 'deviceName', 'model', 'osFamily', 'osVersion']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (typeof value.challengeId !== 'string' || typeof value.clientSecret !== 'string' || typeof value.code !== 'string') return null;
  if (typeof value.deviceInstallationId !== 'string' || !value.deviceInstallationId.trim() || !text(value.deviceInstallationId, 160)) return null;
  if (typeof value.publicKey !== 'string' || !value.publicKey || !text(value.publicKey, 4096)) return null;
  if (typeof value.deviceName !== 'string' || !value.deviceName.trim() || !text(value.deviceName, 160)) return null;
  if (value.model !== undefined && !text(value.model, 160)) return null;
  if (value.osFamily !== undefined && !text(value.osFamily, 80)) return null;
  if (value.osVersion !== undefined && !text(value.osVersion, 80)) return null;
  return { challengeId: value.challengeId, clientSecret: value.clientSecret, code: value.code, device: {
    deviceInstallationId: value.deviceInstallationId.trim(), publicKey: value.publicKey, deviceName: value.deviceName,
    ...(value.model !== undefined ? { model: value.model as string } : {}), ...(value.osFamily !== undefined ? { osFamily: value.osFamily as string } : {}),
    ...(value.osVersion !== undefined ? { osVersion: value.osVersion as string } : {}) } };
}
