import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { encryptToHubKey } from '@/lib/hubOperatorCredentials';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true });
    const attemptId = String(hub.body.attemptId ?? '');
    const challenge = String(hub.body.challenge ?? '');
    if (!attemptId || !challenge) throw new Stage1AuthError(400, 'pairing_proof_fields_invalid', 'Attempt and challenge are required');
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const attempt = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { id: true, hubInstallationId: true, manufacturingIdentityId: true, state: true, challengeHash: true, challengeExpiresAt: true, expiresAt: true } });
      if (!attempt || attempt.hubInstallationId !== hub.installation.id || !attempt.challengeHash || attempt.challengeHash !== sha256(challenge) || !attempt.challengeExpiresAt || attempt.challengeExpiresAt <= now || attempt.expiresAt <= now) throw new Stage1AuthError(401, 'pairing_proof_invalid', 'The provisioning proof is invalid');
      if (!['CHALLENGE_ISSUED', 'HUB_PROVED', 'CREDENTIAL_DELIVERED'].includes(attempt.state)) throw new Stage1AuthError(409, 'pairing_proof_state_invalid', 'The provisioning attempt is not awaiting proof');
      const current = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, purpose: 'machine-credential', state: { in: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'ACTIVE'] } }, orderBy: { version: 'desc' }, select: { version: true, encryptedDeliveryEnvelope: true, tokenHash: true, state: true } });
      if (current?.encryptedDeliveryEnvelope && current.state !== 'REVOKED') return { attemptId, version: current.version, envelope: current.encryptedDeliveryEnvelope, state: attempt.state };
      const credential = `dno_machine_${randomSecret(32)}`;
      const version = (await tx.hubCredentialVersion.aggregate({ where: { hubInstallationId: hub.installation.id, purpose: 'machine-credential' }, _max: { version: true } }))._max.version ?? 0;
      const nextVersion = Number(version) + 1;
      const envelope = encryptToHubKey(credential, hub.identity.encryptionPublicKey, 'machine-credential', nextVersion);
      await tx.hubCredentialVersion.create({ data: { hubInstallationId: hub.installation.id, version: nextVersion, purpose: 'machine-credential', state: 'DELIVERED', tokenHash: sha256(credential), encryptedDeliveryEnvelope: envelope, ciphertextKeyVersion: 1, deliveredAt: now, deliveryAttempts: 1 } });
      await tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { state: 'CREDENTIAL_DELIVERED', hubProofAt: now, encryptedCredentialEnvelope: envelope, deliveredAt: now } });
      return { attemptId, version: nextVersion, envelope, state: 'CREDENTIAL_DELIVERED' };
    });
    return NextResponse.json({ ok: true, attemptId: result.attemptId, version: result.version, envelope: result.envelope, state: result.state }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
