import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, recordFailedAuthentication, Stage1AuthError, cookieToken } from '@/lib/stage1Auth';
import { verifyPassword } from '@/lib/passwords';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

function text(value: unknown, max: number): string {
  const result = String(value ?? '').trim();
  return result.length > max ? '' : result;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = text(body.email, 320).toLowerCase();
    const password = String(body.password ?? '');
    const deviceInstallationId = text(body.deviceInstallationId, 160);
    const publicKey = text(body.publicKey, 4096);
    const deviceName = text(body.deviceName, 160);
    if (!email || !password || !deviceInstallationId || !publicKey || !deviceName) {
      await recordFailedAuthentication('customer_login_failed', email || 'missing-email');
      throw new Stage1AuthError(400, 'customer_login_fields_invalid', 'Email, password and trusted-device details are required');
    }
    await enforcePersistentRateLimit(`customer-login:${sha256(email)}`, 8, 15 * 60 * 1000);
    try { crypto.createPublicKey(publicKey); } catch { throw new Stage1AuthError(400, 'trusted_device_key_invalid', 'The trusted-device public key is invalid'); }
    const account = await prisma.customerAccount.findUnique({ where: { emailNormalized: email }, select: { id: true, status: true, emailVerifiedAt: true, passwordHash: true, securityVersion: true } });
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt || !(await verifyPassword(password, account.passwordHash))) {
      await recordFailedAuthentication('customer_login_failed', email);
      throw new Stage1AuthError(401, 'customer_credentials_invalid', 'The customer credentials are invalid');
    }
    const thumbprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
    const rawSession = `dno-customer-session-${randomSecret(32)}`;
    const session = await prisma.$transaction(async (tx) => {
      const trusted = await tx.trustedDevice.upsert({
        where: { customerAccountId_deviceInstallationId: { customerAccountId: account.id, deviceInstallationId } },
        create: { customerAccountId: account.id, deviceInstallationId, publicKey, publicKeyThumbprint: thumbprint, deviceName, model: text(body.model, 160) || null, osFamily: text(body.osFamily, 80) || null, osVersion: text(body.osVersion, 80) || null },
        update: { publicKey, publicKeyThumbprint: thumbprint, deviceName, lastUsedAt: new Date(), revokedAt: null, sessionVersion: { increment: 1 } },
        select: { id: true, sessionVersion: true },
      });
      const created = await tx.customerSession.create({ data: { customerAccountId: account.id, trustedDeviceId: trusted.id, refreshTokenHash: sha256(rawSession), securityVersion: account.securityVersion, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, select: { id: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { actorType: 'CUSTOMER', actorId: account.id, category: 'SECURITY', action: 'customer_login_succeeded', targetType: 'CustomerSession', targetId: created.id, metadata: { trustedDeviceId: trusted.id, outcome: 'succeeded' }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
      return { ...created, trustedDeviceId: trusted.id };
    });
    const response = NextResponse.json({ ok: true, accountId: account.id, sessionId: session.id, trustedDeviceId: session.trustedDeviceId, expiresAt: session.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    response.headers.append('Set-Cookie', `dinodia_customer_session=${encodeURIComponent(rawSession)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
    return response;
  } catch (error) { return authErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const rawSession = request.headers.get('x-dinodia-session') || cookieToken(request, 'dinodia_customer_session');
    if (!rawSession) throw new Stage1AuthError(401, 'customer_session_required', 'A customer session is required');
    await prisma.customerSession.updateMany({ where: { refreshTokenHash: sha256(rawSession), revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'customer_logout' } });
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.headers.append('Set-Cookie', 'dinodia_customer_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0');
    return response;
  } catch (error) { return authErrorResponse(error); }
}
