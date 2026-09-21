import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { decryptSecret, encryptSecret } from '@/lib/hubCrypto';

const hash = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiBadRequest('Invalid body.');
  const auth = await authenticateProvisioningHubRequest(body, req, '/api/hub-agent/v2/pairing/challenge');
  if ('error' in auth) return auth.error;
  const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
  if (!attemptId) return apiBadRequest('A provisioning attempt is required.');
  const attempt = await prisma.hubProvisioningAttempt.findFirst({ where: { attemptId, serial: auth.serial }, select: { id: true, state: true, revokedAt: true, expiresAt: true, challengeHash: true, challengeCiphertext: true, challengeExpiresAt: true } });
  if (!attempt || attempt.revokedAt || attempt.expiresAt <= new Date()) return apiFailFromStatus(410, 'The provisioning attempt has expired.');
  if (!['REDEEMED', 'CHALLENGE_SENT', 'CREDENTIAL_DELIVERED'].includes(attempt.state)) return apiFailFromStatus(409, 'The Company Portal must approve this provisioning attempt first.');
  const now = new Date();
  if (attempt.challengeHash && attempt.challengeCiphertext && attempt.challengeExpiresAt && attempt.challengeExpiresAt > now) {
    return NextResponse.json({ ok: true, attemptId, challenge: decryptSecret(attempt.challengeCiphertext), expiresAt: attempt.challengeExpiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
  }
  const challenge = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const updated = await prisma.hubProvisioningAttempt.updateMany({ where: { id: attempt.id, state: { in: ['REDEEMED', 'CHALLENGE_SENT'] }, revokedAt: null }, data: { state: 'CHALLENGE_SENT', challengeHash: hash(challenge), challengeCiphertext: encryptSecret(challenge), challengeIssuedAt: now, challengeExpiresAt: expiresAt } });
  if (updated.count !== 1) return apiFailFromStatus(409, 'The provisioning attempt changed; retry the handshake.');
  return NextResponse.json({ ok: true, attemptId, challenge, expiresAt: expiresAt.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
}
