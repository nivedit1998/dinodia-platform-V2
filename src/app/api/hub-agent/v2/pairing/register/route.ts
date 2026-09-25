import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { sha256 } from '@/lib/stage1Crypto';
import { verifyEmbeddedHubSignature, verifyManufacturingRoot } from '@/lib/stage1HubAuth';
import { validateManufacturingIdentity } from '@/lib/manufacturingEnrollment';

export const dynamic = 'force-dynamic';

function publicFingerprint(pem: string): string {
  return crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
}

function asEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const envelope = body.envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Stage1AuthError(400, 'pairing_envelope_invalid', 'The pairing envelope is invalid');
  return envelope as Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 128 * 1024) throw new Stage1AuthError(413, 'pairing_body_too_large', 'The pairing request is too large');
    const body = JSON.parse(raw) as Record<string, unknown>;
    const envelope = asEnvelope(body);
    const serialNumber = String(envelope.serial ?? '').trim();
    const signingPublicKey = String(envelope.publicKeyPem ?? '');
    const encryptionPublicKey = String(envelope.encryptionPublicKeyPem ?? '');
    const identityGeneration = Number(envelope.identityGeneration);
    const attemptId = String(envelope.attemptId ?? '').trim();
    const presentation = String(body.code ?? '');
    const baseUrl = String(envelope.baseUrl ?? '').trim();
    const expiresAt = new Date(Number(envelope.expiresAt));
    if (!serialNumber || !signingPublicKey || !encryptionPublicKey || !Number.isInteger(identityGeneration) || identityGeneration < 1 || !attemptId || presentation.length < 16 || !/^https?:\/\//i.test(baseUrl) || !Number.isFinite(expiresAt.getTime())) throw new Stage1AuthError(400, 'pairing_fields_invalid', 'The pairing request is incomplete');
    let signingKey: crypto.KeyObject;
    try { signingKey = crypto.createPublicKey(signingPublicKey); } catch { throw new Stage1AuthError(401, 'pairing_key_invalid', 'The hub signing identity is invalid'); }
    if (!verifyManufacturingRoot(envelope) || !verifyEmbeddedHubSignature(envelope, signingKey)) throw new Stage1AuthError(401, 'manufacturing_identity_untrusted', 'The hub manufacturing identity is not trusted');
    const manufacturing = validateManufacturingIdentity(envelope as typeof envelope & { serial: string; identityGeneration: number; publicKeyPem: string; encryptionPublicKeyPem: string; publicKeyFingerprint: string; encryptionKeyFingerprint: string; manufacturingRootSignature?: string; manufacturingSignature?: string });
    const signingKeyFingerprint = manufacturing.signingKeyFingerprint;
    const encryptionKeyFingerprint = manufacturing.encryptionKeyFingerprint;
    if (String(envelope.publicKeyFingerprint) !== signingKeyFingerprint) throw new Stage1AuthError(401, 'pairing_key_fingerprint_mismatch', 'The hub signing fingerprint does not match');
    if (String(envelope.encryptionKeyFingerprint ?? publicFingerprint(encryptionPublicKey)) !== encryptionKeyFingerprint) throw new Stage1AuthError(401, 'pairing_encryption_fingerprint_mismatch', 'The hub encryption fingerprint does not match');
    if (expiresAt <= new Date()) throw new Stage1AuthError(401, 'pairing_expired', 'The provisioning presentation has expired');
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const identity = await tx.hubManufacturingIdentity.findFirst({ where: { serialNumber, identityGeneration }, select: { id: true, signingKeyFingerprint: true, encryptionKeyFingerprint: true, status: true } });
      if (!identity || identity.status !== 'ACTIVE' || identity.signingKeyFingerprint !== signingKeyFingerprint || identity.encryptionKeyFingerprint !== encryptionKeyFingerprint) throw new Stage1AuthError(401, 'manufacturing_identity_rejected', 'The hub identity generation is not registered');
      const existing = await tx.hubProvisioningAttempt.findFirst({ where: { attemptId }, select: { attemptId: true, state: true, expiresAt: true, id: true, manufacturingIdentityId: true } });
      if (existing) {
        if (existing.manufacturingIdentityId !== identity.id || existing.expiresAt <= now || ['EXPIRED', 'REVOKED'].includes(existing.state)) throw new Stage1AuthError(409, 'pairing_attempt_rejected', 'The provisioning attempt cannot be resumed');
        return { attemptId: existing.attemptId, state: existing.state, expiresAt: existing.expiresAt };
      }
      const previous = await tx.hubProvisioningAttempt.findMany({ where: { manufacturingIdentityId: identity.id, state: { in: ['CREATED', 'PRESENTED', 'CHALLENGE_PENDING'] }, expiresAt: { gt: now } }, select: { id: true } });
      if (previous.length) await tx.hubProvisioningAttempt.updateMany({ where: { id: { in: previous.map((row) => row.id) } }, data: { state: 'REVOKED' } });
      const attempt = await tx.hubProvisioningAttempt.create({ data: { attemptId, manufacturingIdentityId: identity.id, state: 'PRESENTED', codeHash: sha256(presentation), baseUrlPresentation: baseUrl, expiresAt, idempotencyKeyHash: sha256(`${serialNumber}:${attemptId}`) }, select: { attemptId: true, state: true, expiresAt: true } });
      return attempt;
    });
    return NextResponse.json({ ok: true, attemptId: result.attemptId, state: result.state, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
