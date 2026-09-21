// Architecture: Shared platform helper src/lib/hubInstall.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { decryptBootstrapSecret } from '@/lib/hubTokens';

export class HubInstallError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'HubInstallError';
  }
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function verifyBootstrapClaim(serialRaw: string, bootstrapSecretRaw: string) {
  const serial = (serialRaw || '').trim();
  const bootstrapSecret = (bootstrapSecretRaw || '').trim();
  if (!serial || !bootstrapSecret) {
    throw new HubInstallError('Serial and bootstrap secret are required.', 400);
  }

  const hubInstall = await prisma.hubInstall.findUnique({
    where: { serial },
    include: {
      home: {
        select: {
          id: true,
          users: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!hubInstall) {
    throw new HubInstallError('That serial is not provisioned.', 404);
  }
  if (hubInstall.home && hubInstall.home.users.length > 0) {
    throw new HubInstallError('This hub is already claimed.', 409);
  }

  const storedSecret = decryptBootstrapSecret(hubInstall.bootstrapSecretCiphertext);
  if (!safeEqual(storedSecret, bootstrapSecret)) {
    throw new HubInstallError('Serial or secret is incorrect.', 401);
  }

  return hubInstall;
}

// Phase 13: allow "lost claim code" recovery and re-claim flows where the home may already have tenants/users.
// This verifies only the bootstrap secret for the hub, without enforcing "home has no users".
export async function verifyBootstrapSecretForRecovery(serialRaw: string, bootstrapSecretRaw: string) {
  const serial = (serialRaw || '').trim();
  const bootstrapSecret = (bootstrapSecretRaw || '').trim();
  if (!serial || !bootstrapSecret) {
    throw new HubInstallError('Serial and bootstrap secret are required.', 400);
  }

  const hubInstall = await prisma.hubInstall.findUnique({
    where: { serial },
    include: {
      home: {
        select: {
          id: true,
          haConnectionId: true,
          haConnection: { select: { ownerId: true } },
        },
      },
    },
  });
  if (!hubInstall) {
    throw new HubInstallError('That serial is not provisioned.', 404);
  }

  const storedSecret = decryptBootstrapSecret(hubInstall.bootstrapSecretCiphertext);
  if (!safeEqual(storedSecret, bootstrapSecret)) {
    throw new HubInstallError('Serial or secret is incorrect.', 401);
  }

  return hubInstall;
}
