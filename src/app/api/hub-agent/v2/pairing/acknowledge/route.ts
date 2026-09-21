import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiBadRequest('Invalid body.');
  const auth = await authenticateProvisioningHubRequest(body, req, '/api/hub-agent/v2/pairing/acknowledge');
  if ('error' in auth) return auth.error;
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
  const version = Number(body.version);
  const credentialFingerprint = typeof body.credentialFingerprint === 'string' ? body.credentialFingerprint.trim() : '';
  if (!attemptId || !Number.isInteger(version) || version < 1 || !/^[a-f0-9]{64}$/i.test(credentialFingerprint)) return apiBadRequest('Attempt, credential version and fingerprint are required.');
  const attempt = await prisma.hubProvisioningAttempt.findFirst({ where: { attemptId, serial: auth.serial }, select: { id: true, state: true, machineCredentialHash: true, machineCredentialVersion: true, expiresAt: true, revokedAt: true } });
  if (!attempt || attempt.revokedAt || attempt.expiresAt <= new Date()) return apiFailFromStatus(410, 'The provisioning attempt has expired.');
  if (attempt.machineCredentialVersion !== version || attempt.machineCredentialHash !== credentialFingerprint) return apiFailFromStatus(409, 'The machine credential acknowledgement does not match the delivered credential.');
  const updated = await prisma.hubProvisioningAttempt.updateMany({ where: { id: attempt.id, state: { in: ['CREDENTIAL_DELIVERED', 'ACKNOWLEDGED'] }, machineCredentialAcknowledgedAt: null, revokedAt: null }, data: { state: 'ACKNOWLEDGED', machineCredentialAcknowledgedAt: new Date(), acknowledgedAt: new Date() } });
  return NextResponse.json({ ok: true, acknowledged: updated.count === 1 || attempt.state === 'ACKNOWLEDGED' }, { headers: { 'Cache-Control': 'no-store, private' } });
}
