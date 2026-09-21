import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { createHubEncryptedCredentialEnvelope } from '@/lib/hubCredentialEnvelope';
import { encryptSecret, hashSha256 } from '@/lib/hubCrypto';

const hash = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiBadRequest('Invalid body.');
  const auth = await authenticateProvisioningHubRequest(body, req, '/api/hub-agent/v2/pairing/prove');
  if ('error' in auth) return auth.error;
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
  const challenge = typeof body.challenge === 'string' ? body.challenge.trim() : '';
  if (!attemptId || !challenge) return apiBadRequest('A provisioning attempt and challenge are required.');
  const attempt = await prisma.hubProvisioningAttempt.findFirst({ where: { attemptId, serial: auth.serial }, include: { identity: { select: { encryptionPublicKey: true } } } });
  if (!attempt || attempt.revokedAt || attempt.expiresAt <= new Date()) return apiFailFromStatus(410, 'The provisioning attempt has expired.');
  if (!attempt.challengeHash || hash(challenge) !== attempt.challengeHash || !attempt.challengeExpiresAt || attempt.challengeExpiresAt <= new Date()) return apiFailFromStatus(409, 'The provisioning challenge is invalid or expired.');
  if (!attempt.identity.encryptionPublicKey) return apiFailFromStatus(503, 'The hub has no registered encryption identity.');
  if (attempt.machineCredentialEnvelope && attempt.machineCredentialVersion && attempt.machineCredentialDeliveredAt) {
    return NextResponse.json({ ok: true, attemptId, version: attempt.machineCredentialVersion, envelope: attempt.machineCredentialEnvelope, expiresAt: attempt.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
  }
  const credential = `dno_machine_${crypto.randomBytes(32).toString('base64url')}`;
  const version = 1;
  const envelope = createHubEncryptedCredentialEnvelope(credential, attempt.identity.encryptionPublicKey, version, 'machine-credential');
  const now = new Date();
  const updated = await prisma.hubProvisioningAttempt.updateMany({ where: { id: attempt.id, state: { in: ['CHALLENGE_SENT', 'CREDENTIAL_DELIVERED'] }, machineCredentialHash: null, revokedAt: null }, data: { state: 'CREDENTIAL_DELIVERED', hubProofAt: now, machineCredentialVersion: version, machineCredentialHash: hashSha256(credential), machineCredentialCiphertext: encryptSecret(credential), machineCredentialEnvelope: envelope, machineCredentialDeliveredAt: now } });
  if (updated.count !== 1) {
    const retry = await prisma.hubProvisioningAttempt.findUnique({ where: { id: attempt.id }, select: { machineCredentialVersion: true, machineCredentialEnvelope: true, machineCredentialDeliveredAt: true, expiresAt: true } });
    if (retry?.machineCredentialEnvelope && retry.machineCredentialVersion && retry.machineCredentialDeliveredAt) return NextResponse.json({ ok: true, attemptId, version: retry.machineCredentialVersion, envelope: retry.machineCredentialEnvelope, expiresAt: retry.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
    return apiFailFromStatus(409, 'The provisioning proof changed; retry the handshake.');
  }
  return NextResponse.json({ ok: true, attemptId, version, envelope, expiresAt: attempt.expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
}
