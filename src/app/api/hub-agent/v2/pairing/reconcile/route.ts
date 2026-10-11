import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/**
 * Reconcile only an already-issued, still-current machine credential when a
 * local OS update lost its paired/version/Home pointers. This is not pairing:
 * it accepts no provisioning attempt or new credential and changes no Home,
 * installation, credential, or sync data. The registered manufacturing
 * identity must sign the request, and the supplied fingerprint must match the
 * exact ACTIVE current credential for the current completed Home install.
 */
export async function POST(request: Request) {
  try {
    if (request.headers.has('x-dinodia-machine-version') || request.headers.has('x-dinodia-machine-signature')) {
      throw new Stage1AuthError(400, 'machine_credential_reconciliation_identity_only', 'Existing-credential reconciliation accepts only the registered hub identity');
    }
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { allowIdentity: true, maxBodyBytes: 8 * 1024 });
    const expectedKeys = ['credentialFingerprint', 'identityGeneration', 'serial'];
    if (Object.keys(hub.body).sort().join(',') !== expectedKeys.join(',')
      || typeof hub.body.credentialFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/i.test(hub.body.credentialFingerprint)) {
      throw new Stage1AuthError(400, 'machine_credential_reconciliation_shape_invalid', 'The existing-credential reconciliation proof is invalid');
    }

    const result = await prisma.$transaction(async (tx) => {
      const installation = await tx.hubInstallation.findUnique({ where: { id: hub.installation.id }, select: {
        id: true, homeId: true, manufacturingIdentityId: true, serialNumberSnapshot: true,
        state: true, lifecycleStatus: true, currentMachineCredentialVersion: true,
      } });
      const home = installation ? await tx.home.findUnique({ where: { id: installation.homeId }, select: {
        id: true, lifecycle: true, installationStatus: true, activeHubInstallationId: true,
      } }) : null;
      const identity = await tx.hubManufacturingIdentity.findUnique({ where: { id: hub.identity.id }, select: {
        id: true, serialNumber: true, identityGeneration: true, status: true,
      } });
      const version = Number(installation?.currentMachineCredentialVersion || 0);
      const credential = installation && version > 0
        ? await tx.hubCredentialVersion.findUnique({ where: { HubCredentialVersion_hub_purpose_version_key: {
          hubInstallationId: installation.id, purpose: 'machine-credential', version,
        } }, select: { id: true, version: true, state: true, tokenHash: true, revokedAt: true } })
        : null;
      const eligible = Boolean(installation && home && identity && credential
        && installation.manufacturingIdentityId === identity.id
        && installation.serialNumberSnapshot === identity.serialNumber
        && installation.serialNumberSnapshot === hub.identity.serialNumber
        && identity.identityGeneration === hub.identity.identityGeneration
        && identity.status === 'ACTIVE'
        && installation.state === 'ACTIVE' && installation.lifecycleStatus === 'ACTIVE'
        && home.activeHubInstallationId === installation.id
        && home.lifecycle === 'ACTIVE' && home.installationStatus === 'COMPLETE'
        && credential.version === version && credential.state === 'ACTIVE' && credential.revokedAt === null
        && credential.tokenHash === hub.body.credentialFingerprint);
      if (!eligible || !installation || !home || !credential) {
        throw new Stage1AuthError(409, 'machine_credential_reconciliation_denied', 'The retained machine credential is not the current credential for an active completed Home installation');
      }
      return { homeId: home.id, hubInstallId: installation.id, version: credential.version };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return NextResponse.json({ ok: true, paired: true, version: result.version, hubInstallId: result.hubInstallId, homeId: result.homeId }, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  } catch (error) { return authErrorResponse(error); }
}
