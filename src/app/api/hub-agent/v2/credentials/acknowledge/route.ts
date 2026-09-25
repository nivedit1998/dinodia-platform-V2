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
    const credential = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, version, purpose: 'operator-credential' }, select: { id: true, tokenHash: true, state: true } });
    if (!credential || credential.tokenHash !== fingerprint || !['DELIVERED', 'ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(401, 'credential_acknowledgement_invalid', 'The credential acknowledgement is invalid');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const acknowledged = await tx.hubCredentialVersion.updateMany({ where: { id: credential.id, purpose: 'operator-credential', state: { in: ['DELIVERED', 'ACKNOWLEDGED'] }, acknowledgedAt: null }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: now } });
      // A retry after activation is an idempotent acknowledgement, not a
      // reason to roll the already-active version back or fail the hub sync.
      if (acknowledged.count !== 1 && !['ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(409, 'credential_acknowledgement_race', 'The operator credential acknowledgement could not be recorded');
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { lastSeenAt: now } });
    });
    return NextResponse.json({ ok: true, version, state: 'ACKNOWLEDGED' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
