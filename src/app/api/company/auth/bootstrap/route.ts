import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { recordFailedAuthentication, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { CxoInvitationDeliveryError, configuredInitialCxoMailbox, sendInitialCxoInvitation } from '@/lib/initialCxoInvitation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function configuredSecret(): string {
  const value = String(process.env.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET ?? '');
  if (!value || value.length < 32) throw new Stage1AuthError(404, 'bootstrap_unavailable', 'Initial employee bootstrap is unavailable');
  return value;
}

function constantTimeSecretMatch(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * The bootstrap capability creates a pending employee and sends the one-use
 * invitation through the configured server-side mail provider. The raw token
 * is never returned to the browser or persisted; completion proves possession
 * through the email link fragment.
 */
export async function POST(request: Request) {
  try {
    const secret = configuredSecret();
    const configuredMailbox = configuredInitialCxoMailbox();
    const supplied = String(request.headers.get('x-dinodia-initial-cxo-secret') ?? '');
    if (!constantTimeSecretMatch(supplied, secret)) {
      await recordFailedAuthentication('initial_cxo_bootstrap_failed', 'initial-cxo-bootstrap');
      throw new Stage1AuthError(401, 'bootstrap_invalid', 'The initial bootstrap ceremony is invalid');
    }
    const source = String(request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'unknown').split(',')[0].trim();
    await enforcePersistentRateLimit(`initial-cxo-bootstrap:${sha256(source)}`, 3, 60 * 60 * 1000);
    const body = await request.json() as Record<string, unknown>;
    const displayName = String(body.displayName ?? '').trim().slice(0, 160);
    const email = String(body.email ?? '').trim().toLowerCase().slice(0, 320);
    if (!displayName || !email || email !== configuredMailbox || body.password !== undefined || body.passwordHash !== undefined) {
      await recordFailedAuthentication('initial_cxo_bootstrap_failed', 'initial-cxo-bootstrap');
      throw new Stage1AuthError(400, 'bootstrap_fields_invalid', 'Display name and work email are required; credentials are chosen through the invitation');
    }
    const invitation = randomSecret(32);
    const invitationHash = sha256(invitation);
    const now = new Date();
    let result: { id: string; emailNormalized: string; expiresAt: Date } | undefined;
    for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          if (await tx.companyEmployeeAccount.count() !== 0) throw new Stage1AuthError(409, 'bootstrap_already_consumed', 'Initial employee bootstrap is already closed');
          const ceremony = await tx.initialCxoBootstrap.upsert({ where: { ceremonyKey: 'initial-cxo-v1' }, create: { ceremonyKey: 'initial-cxo-v1' }, update: {} });
          if (ceremony.consumedAt || (ceremony.invitationHash && ceremony.invitationExpiresAt && ceremony.invitationExpiresAt > now)) throw new Stage1AuthError(409, 'bootstrap_already_consumed', 'Initial employee bootstrap is already closed or awaiting delivery');
          const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const employee = await tx.companyEmployeeAccount.create({ data: { displayName, email, emailNormalized: email, role: 'CXO', status: 'PENDING', bootstrapInvitationHash: invitationHash, bootstrapInvitationExpiresAt: expiresAt }, select: { id: true, emailNormalized: true } });
          await tx.initialCxoBootstrap.update({ where: { id: ceremony.id }, data: { invitationHash, invitationExpiresAt: expiresAt, deliveryStatus: 'PENDING', deliveryAttempts: { increment: 1 }, lastDeliveryFailureCode: null } });
          await tx.auditEvent.create({ data: { actorType: 'SYSTEM', actorId: null, category: 'SECURITY', action: 'initial_cxo_bootstrap_invitation_created', targetType: 'CompanyEmployeeAccount', targetId: employee.id, metadata: { outcome: 'pending', invitationExpiresAt: expiresAt.toISOString() }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
          return { ...employee, expiresAt };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if (code === 'P2034' && attempt < 2) continue;
        throw error;
      }
    }
    if (!result) throw new Stage1AuthError(503, 'bootstrap_retry_exhausted', 'The initial bootstrap could not be completed safely; please retry');
    try {
      await sendInitialCxoInvitation({ displayName, invitation, expiresAt: result.expiresAt });
      await prisma.initialCxoBootstrap.updateMany({ where: { ceremonyKey: 'initial-cxo-v1', invitationHash: invitationHash, consumedAt: null }, data: { deliveryStatus: 'SENT', lastDeliveryAt: new Date(), lastDeliveryFailureCode: null } });
    } catch (error) {
      const deliveryCode = error instanceof CxoInvitationDeliveryError ? error.code : 'provider_send_failed';
      await prisma.initialCxoBootstrap.updateMany({ where: { ceremonyKey: 'initial-cxo-v1', invitationHash: invitationHash, consumedAt: null }, data: { deliveryStatus: 'FAILED', lastDeliveryFailureCode: deliveryCode } });
      throw new Stage1AuthError(503, 'bootstrap_delivery_failed', 'The invitation could not be delivered; retry the ceremony to issue a new one');
    }
    return NextResponse.json({ ok: true, invitationId: 'opaque', email: result.emailNormalized, expiresAt: result.expiresAt, delivery: 'sent' }, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof CxoInvitationDeliveryError && /^missing_|^invalid_/.test(error.code)) {
      return authErrorResponse(new Stage1AuthError(503, 'bootstrap_unavailable', 'Initial employee bootstrap is not configured for delivery'));
    }
    return authErrorResponse(error);
  }
}
