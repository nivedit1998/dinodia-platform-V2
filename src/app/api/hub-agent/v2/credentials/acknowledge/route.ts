import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const version = Number(hub.body.version);
    const fingerprint = String(hub.body.credentialFingerprint ?? '');
    if (!Number.isInteger(version) || !/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Stage1AuthError(400, 'credential_acknowledgement_invalid', 'A version and fingerprint are required');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, version, purpose: 'operator-credential' }, select: { id: true, tokenHash: true, state: true, acknowledgedAt: true } });
      if (!credential || credential.tokenHash !== fingerprint || !['DELIVERED', 'ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(401, 'credential_acknowledgement_invalid', 'The credential acknowledgement is invalid');
      // Receipt acknowledgement is a durable transition separate from
      // activation. Exact-version retries remain idempotent, including when
      // another retry has already advanced the credential to ACTIVE.
      if (!credential.acknowledgedAt) {
        const acknowledged = await tx.hubCredentialVersion.updateMany({ where: { id: credential.id, hubInstallationId: hub.installation.id, purpose: 'operator-credential', tokenHash: fingerprint, state: 'DELIVERED', acknowledgedAt: null, revokedAt: null }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: now } });
        if (acknowledged.count === 1) {
          await tx.auditEvent.create({ data: {
            homeId: hub.installation.homeId,
            actorType: 'HUB',
            actorId: hub.installation.id,
            category: 'SECURITY',
            action: 'operator_credential_acknowledged',
            targetType: 'HubCredentialVersion',
            targetId: credential.id,
            metadata: { version, outcome: 'acknowledged' },
            purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
          } });
        } else {
          // A simultaneous exact-version retry may have won the compare-and-set
          // while this request waited on the row lock. Accept only that durable
          // convergence; a revoke or a different fingerprint remains a denial.
          const converged = await tx.hubCredentialVersion.findUnique({ where: { id: credential.id }, select: { tokenHash: true, state: true, acknowledgedAt: true } });
          if (!converged || converged.tokenHash !== fingerprint || !converged.acknowledgedAt || !['ACKNOWLEDGED', 'ACTIVE'].includes(converged.state)) throw new Stage1AuthError(409, 'credential_acknowledgement_race', 'The operator credential acknowledgement could not be recorded');
        }
      }
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { lastSeenAt: now } });
    });
    return NextResponse.json({ ok: true, version, state: 'ACKNOWLEDGED' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
