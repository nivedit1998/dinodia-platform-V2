import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/** Activation is deliberately separate from receipt acknowledgement. */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const version = Number(hub.body.version);
    const fingerprint = String(hub.body.credentialFingerprint ?? '');
    if (!Number.isInteger(version) || !/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Stage1AuthError(400, 'credential_activation_invalid', 'A version and fingerprint are required');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', version }, select: { id: true, tokenHash: true, state: true, acknowledgedAt: true, activatedAt: true } });
      if (!credential || credential.tokenHash !== fingerprint || !credential.acknowledgedAt || !['ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(409, 'credential_not_acknowledged', 'The exact operator credential must be acknowledged before activation');
      if (credential.state === 'ACTIVE') return;
      await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: 'ACTIVE', id: { not: credential.id } }, data: { state: 'GRACE', graceUntil: new Date(now.getTime() + 20 * 60 * 1000) } });
      await tx.hubCredentialVersion.update({ where: { id: credential.id }, data: { state: 'ACTIVE', activatedAt: now } });
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { currentOperatorCredentialVersion: version, lastSeenAt: now } });
    });
    return NextResponse.json({ ok: true, version, state: 'ACTIVE' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
