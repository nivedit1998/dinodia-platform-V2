import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { recordFailedAuthentication, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { CxoInvitationDeliveryError, configuredInitialCxoMailbox, sendInitialCxoInvitation } from '@/lib/initialCxoInvitation';
import { isRetryableSerializationConflict, serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function configuredSecret(): string {
  const value = String(process.env.COMPANY_PORTAL_INITIAL_CXO_BOOTSTRAP_SECRET ?? '');
  if (!value || value.length < 32) throw new Stage1AuthError(404, 'bootstrap_unavailable', 'Initial employee bootstrap is unavailable');
  return value;
}

function matches(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/** Reissues a failed/expired invitation without ever returning its token. */
export async function POST(request: Request) {
  try {
    const secret = configuredSecret();
    const supplied = String(request.headers.get('x-dinodia-initial-cxo-secret') ?? '');
    if (!matches(supplied, secret)) {
      await recordFailedAuthentication('initial_cxo_bootstrap_retry_failed', 'initial-cxo-bootstrap');
      throw new Stage1AuthError(401, 'bootstrap_invalid', 'The initial bootstrap ceremony is invalid');
    }
    await enforcePersistentRateLimit('initial-cxo-bootstrap-retry', 3, 60 * 60 * 1000);
    const recipient = configuredInitialCxoMailbox();
    const invitation = randomSecret(32);
    const invitationHash = sha256(invitation);
    let pending: { id: string; displayName: string; emailNormalized: string; expiresAt: Date } | undefined;
    try {
      pending = await serializableTransaction(async (tx) => {
          // Serialize invitation replacement on the durable ceremony row.
          // A second retry must observe the first request's PENDING/SENT state
          // after waiting, rather than issuing a competing token from a stale
          // pre-lock read.
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "InitialCxoBootstrap" WHERE "ceremonyKey" = 'initial-cxo-v1' FOR UPDATE`;
          if (locked.length !== 1) throw new Stage1AuthError(409, 'bootstrap_retry_unavailable', 'There is no failed or expired invitation to retry');
          const ceremony = await tx.initialCxoBootstrap.findUnique({ where: { ceremonyKey: 'initial-cxo-v1' } });
          if (!ceremony || ceremony.consumedAt) throw new Stage1AuthError(409, 'bootstrap_already_consumed', 'Initial employee bootstrap is already closed');
          const now = new Date();
          if (ceremony.deliveryStatus === 'PENDING'
            || (ceremony.deliveryStatus === 'SENT' && ceremony.invitationExpiresAt && ceremony.invitationExpiresAt > now)) {
            throw new Stage1AuthError(409, 'bootstrap_delivery_pending', 'The current invitation is still being delivered or remains valid; do not issue another one');
          }
          const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const employee = await tx.companyEmployeeAccount.findFirst({ where: { status: 'PENDING', emailNormalized: recipient }, select: { id: true, displayName: true, emailNormalized: true } });
          if (!employee) throw new Stage1AuthError(409, 'bootstrap_retry_unavailable', 'There is no failed or expired invitation to retry');
          await tx.companyEmployeeAccount.update({ where: { id: employee.id }, data: { bootstrapInvitationHash: invitationHash, bootstrapInvitationExpiresAt: expiresAt } });
          await tx.initialCxoBootstrap.update({ where: { id: ceremony.id }, data: { invitationHash, invitationExpiresAt: expiresAt, deliveryStatus: 'PENDING', deliveryAttempts: { increment: 1 }, lastDeliveryFailureCode: null } });
          await tx.auditEvent.create({ data: { actorType: 'SYSTEM', actorId: null, category: 'SECURITY', action: 'initial_cxo_bootstrap_invitation_reissued', targetType: 'CompanyEmployeeAccount', targetId: employee.id, metadata: { outcome: 'pending', ceremony: 'initial-cxo-v1' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
          return { ...employee, expiresAt };
        });
    } catch (error) {
      if (isRetryableSerializationConflict(error)) {
        throw new Stage1AuthError(503, 'bootstrap_retry_exhausted', 'The initial bootstrap could not be retried safely; please retry');
      }
      throw error;
    }
    try {
      await sendInitialCxoInvitation({ displayName: pending.displayName, invitation, expiresAt: pending.expiresAt });
      await prisma.initialCxoBootstrap.updateMany({ where: { ceremonyKey: 'initial-cxo-v1', invitationHash, consumedAt: null }, data: { deliveryStatus: 'SENT', lastDeliveryAt: new Date(), lastDeliveryFailureCode: null } });
    } catch (error) {
      const deliveryCode = error instanceof CxoInvitationDeliveryError ? error.code : 'provider_send_failed';
      await prisma.initialCxoBootstrap.updateMany({ where: { ceremonyKey: 'initial-cxo-v1', invitationHash, consumedAt: null }, data: { deliveryStatus: 'FAILED', lastDeliveryFailureCode: deliveryCode } });
      throw new Stage1AuthError(503, 'bootstrap_delivery_failed', 'The invitation could not be delivered; retry the ceremony to issue a new one');
    }
    return NextResponse.json({ ok: true, invitationId: 'opaque', email: pending.emailNormalized, expiresAt: pending.expiresAt, delivery: 'sent' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof CxoInvitationDeliveryError && /^missing_|^invalid_/.test(error.code)) {
      return authErrorResponse(new Stage1AuthError(503, 'bootstrap_unavailable', 'Initial employee bootstrap is not configured for delivery'));
    }
    return authErrorResponse(error);
  }
}
