// Architecture: signed Dinodia OS -> platform authentication for native Alexa
// projection updates.  This intentionally reuses the rotating hub sync secret;
// Alexa credentials and bearer tokens never cross this boundary.
import { prisma } from '@/lib/prisma';
import { decryptSyncSecret } from '@/lib/hubTokens';
import { verifyHmac } from '@/lib/hubCrypto';
import { enforceHubReplayProtection, HubReplayError } from '@/lib/hubReplayProtection';

export type NativeHubEnvelope = {
  serial?: unknown;
  ts?: unknown;
  nonce?: unknown;
  sig?: unknown;
};

export async function authenticateNativeHubEnvelope(body: NativeHubEnvelope) {
  const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
  const ts = typeof body.ts === 'number' ? body.ts : Number(body.ts);
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
  const sig = typeof body.sig === 'string' ? body.sig.trim() : '';
  if (!serial || !Number.isFinite(ts) || !nonce || !sig) {
    throw Object.assign(new Error('serial, ts, nonce, sig are required.'), { statusCode: 400, code: 'invalid_hub_envelope' });
  }

  const hubInstall = await prisma.hubInstall.findUnique({
    where: { serial },
    select: {
      id: true,
      serial: true,
      syncSecretCiphertext: true,
      homeId: true,
      runtimeCapabilities: true,
      home: { select: { id: true, haConnectionId: true, timeZone: true } },
    },
  });
  if (!hubInstall) throw Object.assign(new Error('Unknown hub serial.'), { statusCode: 404, code: 'unknown_hub' });
  if (!hubInstall.syncSecretCiphertext || !hubInstall.homeId || !hubInstall.home) {
    throw Object.assign(new Error('Hub is not paired to an active home.'), { statusCode: 409, code: 'hub_not_paired' });
  }

  try {
    verifyHmac({ serial, ts, nonce, sig }, decryptSyncSecret(hubInstall.syncSecretCiphertext));
    await enforceHubReplayProtection({ serial, nonce, ts });
  } catch (error) {
    if (error instanceof HubReplayError) {
      throw Object.assign(new Error('Replay detected'), { statusCode: 401, code: 'hub_replay' });
    }
    throw Object.assign(new Error('Invalid hub signature.'), { statusCode: 401, code: 'invalid_hub_signature' });
  }

  return hubInstall;
}

export function nativeHubCapabilityEnabled(hubInstall: { runtimeCapabilities: unknown }, capability: string) {
  const caps = hubInstall.runtimeCapabilities;
  return Boolean(caps && typeof caps === 'object' && !Array.isArray(caps) && (caps as Record<string, unknown>)[capability] === true);
}
