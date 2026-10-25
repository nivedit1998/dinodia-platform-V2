import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true });
    const attemptId = String(hub.body.attemptId ?? '');
    const version = Number(hub.body.version);
    const fingerprint = String(hub.body.credentialFingerprint ?? '');
    if (!attemptId || !Number.isInteger(version) || !/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Stage1AuthError(400, 'acknowledgement_fields_invalid', 'The credential acknowledgement is incomplete');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { id: true, hubInstallationId: true, state: true } });
      if (!attempt || attempt.hubInstallationId !== hub.installation.id || !['CREDENTIAL_DELIVERED', 'ACKNOWLEDGED', 'CONSUMED'].includes(attempt.state)) throw new Stage1AuthError(409, 'acknowledgement_state_invalid', 'The provisioning attempt is not awaiting acknowledgement');
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, version, purpose: 'machine-credential' }, select: { id: true, tokenHash: true, state: true } });
      if (!credential || credential.tokenHash !== fingerprint || !['DELIVERED', 'ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(401, 'credential_acknowledgement_invalid', 'The credential acknowledgement is invalid');
      await tx.hubCredentialVersion.update({ where: { id: credential.id }, data: { state: 'ACTIVE', acknowledgedAt: credential.state === 'DELIVERED' ? now : undefined, activatedAt: credential.state === 'ACTIVE' ? undefined : now } });
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { currentMachineCredentialVersion: version, state: 'PROVISIONED' } });
      await tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: now } });
    });
    return NextResponse.json({ ok: true, acknowledged: true, version }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
