import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true });
    const attemptId = String(hub.body.attemptId ?? '');
    if (!attemptId) throw new Stage1AuthError(400, 'attempt_id_required', 'A provisioning attempt is required');
    const now = new Date();
    const challenge = randomSecret(32);
    const row = await prisma.$transaction(async (tx) => {
      const attempt = await tx.hubProvisioningAttempt.findUnique({ where: { attemptId }, select: { id: true, hubInstallationId: true, manufacturingIdentityId: true, state: true, expiresAt: true } });
      if (!attempt || attempt.hubInstallationId !== hub.installation.id || attempt.expiresAt <= now || !['EMPLOYEE_APPROVED', 'CHALLENGE_PENDING', 'CHALLENGE_ISSUED'].includes(attempt.state)) throw new Stage1AuthError(403, 'pairing_challenge_denied', 'The provisioning attempt is not approved');
      return tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { state: 'CHALLENGE_ISSUED', challengeHash: sha256(challenge), challengeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000) }, select: { attemptId: true, state: true, challengeExpiresAt: true } });
    });
    return NextResponse.json({ ok: true, attemptId: row.attemptId, state: row.state, challenge, expiresAt: row.challengeExpiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
