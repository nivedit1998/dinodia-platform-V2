import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { apiFailFromStatus } from '@/lib/apiError';
import { enforceHubReplayProtection, HubReplayError } from '@/lib/hubReplayProtection';
import { hashRequestBody, verifyHubRequestSignature } from '@/lib/hubSignedRequests';

export async function authenticateProvisioningHubRequest(body: Record<string, unknown>, req: Request, path: string) {
  const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
  if (!serial) return { error: apiFailFromStatus(400, 'Hub serial is required.') } as const;
  const identity = await prisma.hubManufacturingIdentity.findUnique({ where: { serial }, select: { id: true, signingPublicKey: true, encryptionPublicKey: true, status: true, revokedAt: true } });
  if (!identity || identity.status === 'REVOKED' || identity.revokedAt) return { error: apiFailFromStatus(401, 'The hub identity is not trusted.') } as const;
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(identity.signingPublicKey); } catch { return { error: apiFailFromStatus(401, 'The hub identity is invalid.') } as const; }
  const timestamp = Number(req.headers.get('x-dinodia-hub-timestamp') || 0);
  const nonce = String(req.headers.get('x-dinodia-hub-nonce') || '');
  const signature = String(req.headers.get('x-dinodia-hub-signature') || '');
  if (!verifyHubRequestSignature({ method: req.method, path, timestamp, nonce, signature, bodyHash: hashRequestBody(body), publicKey })) return { error: apiFailFromStatus(401, 'A valid hub signature is required.') } as const;
  try { await enforceHubReplayProtection({ serial, nonce, ts: timestamp }); } catch (error) { if (error instanceof HubReplayError) return { error: apiFailFromStatus(409, 'This hub request has already been used.') } as const; throw error; }
  return { serial, identity } as const;
}
