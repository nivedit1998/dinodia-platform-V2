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
    let committed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      try {
        await prisma.$transaction(async (tx) => {
      const credential = await tx.hubCredentialVersion.findFirst({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', version }, select: { id: true, tokenHash: true, state: true, acknowledgedAt: true, activatedAt: true, revokedAt: true } });
      if (!credential || credential.tokenHash !== fingerprint || credential.revokedAt || !credential.acknowledgedAt || !['ACKNOWLEDGED', 'ACTIVE'].includes(credential.state)) throw new Stage1AuthError(409, 'credential_not_acknowledged', 'The exact operator credential must be acknowledged before activation');
      if (credential.state === 'ACTIVE') return;
      const previous = await tx.hubCredentialVersion.findMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: 'ACTIVE', id: { not: credential.id }, revokedAt: null }, select: { id: true, version: true } });
      const graceUntil = new Date(now.getTime() + 20 * 60 * 1000);
      await tx.hubCredentialVersion.updateMany({ where: { hubInstallationId: hub.installation.id, purpose: 'operator-credential', state: 'ACTIVE', id: { not: credential.id }, revokedAt: null }, data: { state: 'GRACE', graceUntil } });
      const activated = await tx.hubCredentialVersion.updateMany({ where: { id: credential.id, hubInstallationId: hub.installation.id, purpose: 'operator-credential', version, tokenHash: fingerprint, state: 'ACKNOWLEDGED', acknowledgedAt: { not: null }, revokedAt: null }, data: { state: 'ACTIVE', activatedAt: now } });
      if (activated.count !== 1) throw new Stage1AuthError(409, 'credential_activation_race', 'The acknowledged operator credential could not be activated');
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { currentOperatorCredentialVersion: version, lastSeenAt: now } });
      await tx.auditEvent.create({ data: {
        homeId: hub.installation.homeId,
        actorType: 'HUB',
        actorId: hub.installation.id,
        category: 'SECURITY',
        action: 'operator_credential_activated',
        targetType: 'HubCredentialVersion',
        targetId: credential.id,
        metadata: { version, outcome: 'active', previousVersions: previous.map((row) => row.version), previousGraceUntil: previous.length ? graceUntil.toISOString() : null },
        purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      } });
      for (const row of previous) {
        await tx.auditEvent.create({ data: {
          homeId: hub.installation.homeId,
          actorType: 'HUB',
          actorId: hub.installation.id,
          category: 'SECURITY',
          action: 'operator_credential_grace_started',
          targetType: 'HubCredentialVersion',
          targetId: row.id,
          metadata: { version: row.version, replacedByVersion: version, graceUntil: graceUntil.toISOString() },
          purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        } });
      }
        }, { isolationLevel: 'Serializable' });
        committed = true;
        break;
      } catch (error) {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if (code === 'P2034' && attempt < 2) continue;
        if (code === 'P2034') throw new Stage1AuthError(503, 'credential_activation_retry_exhausted', 'The credential activation could not be serialized safely; retry the same version');
        throw error;
      }
    }
    if (!committed) throw new Stage1AuthError(503, 'credential_activation_retry_exhausted', 'The credential activation could not be committed safely; retry the same version');
    return NextResponse.json({ ok: true, version, state: 'ACTIVE' }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
