// Stage 1: signed CloudURL synchronisation and independent remote challenge.
// The hub proves the URL it created; Platform then reaches that URL itself.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { hashRequestBody, verifyHubRequestSignature } from '@/lib/hubSignedRequests';

const COMPANY_HOST = /(^|\.)dinodiasmartliving\.com$/i;
function safeCloudUrl(value: unknown) {
  try { const url = new URL(String(value || '').trim()); if (url.protocol !== 'https:' || !COMPANY_HOST.test(url.hostname) || url.username || url.password || url.search || url.hash) return null; return url.toString().replace(/\/$/, ''); } catch { return null; }
}

function canonicalCloudChallengeResponse(input: { version: number; serial: string; cloudUrl: string; challenge: string; identityFingerprint: string; identityGeneration: number }) {
  return JSON.stringify({ version: input.version, serial: input.serial, cloudUrl: input.cloudUrl, challenge: input.challenge, identityFingerprint: input.identityFingerprint, identityGeneration: input.identityGeneration });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { serial?: unknown; cloudUrl?: unknown } | null;
  const serial = typeof body?.serial === 'string' ? body.serial.trim() : '';
  const cloudUrl = safeCloudUrl(body?.cloudUrl);
  if (!serial || !cloudUrl) return apiBadRequest('A Dinodia company CloudURL and serial are required.');
  const identity = await prisma.hubManufacturingIdentity.findUnique({ where: { serial }, select: { id: true, signingPublicKey: true, publicKeyFingerprint: true, identityGeneration: true, status: true, revokedAt: true } });
  if (!identity || identity.status === 'REVOKED' || identity.revokedAt) return apiFailFromStatus(401, 'The hub identity is not trusted.');
  const timestamp = Number(req.headers.get('x-dinodia-hub-timestamp') || 0); const nonce = String(req.headers.get('x-dinodia-hub-nonce') || ''); const signature = String(req.headers.get('x-dinodia-hub-signature') || '');
  let publicKey: crypto.KeyObject; try { publicKey = crypto.createPublicKey(identity.signingPublicKey); } catch { return apiFailFromStatus(401, 'The hub identity is invalid.'); }
  if (!verifyHubRequestSignature({ method: 'POST', path: '/api/hub-agent/v2/pairing/cloud-url', timestamp, nonce, signature, bodyHash: hashRequestBody(body), publicKey })) return apiFailFromStatus(401, 'A valid hub signature is required.');
  try { await prisma.hubAgentNonce.create({ data: { serial, nonce, ts: BigInt(timestamp) } }); } catch { return apiFailFromStatus(409, 'This hub request has already been used.'); }
  const attempt = await prisma.hubProvisioningAttempt.findFirst({ where: { serial, state: { in: ['PENDING', 'REDEEMED', 'CHALLENGE_SENT', 'CREDENTIAL_DELIVERED', 'ACKNOWLEDGED', 'COMPLETED'] }, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!attempt) return apiFailFromStatus(404, 'No active provisioning attempt exists for this hub.');
  const challenge = crypto.randomBytes(24).toString('base64url'); let verified = false;
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
    const response = await fetch(`${cloudUrl}/_dinodia/cloud-challenge?challenge=${encodeURIComponent(challenge)}`, { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } }).finally(() => clearTimeout(timer));
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    const version = Number(result.version);
    const responseCloudUrl = safeCloudUrl(result.cloudUrl);
    const identityFingerprint = String(result.identityFingerprint || '');
    const hubSignature = String(result.hubSignature || '');
    const identityGeneration = Number(result.identityGeneration);
    const canonical = responseCloudUrl ? canonicalCloudChallengeResponse({ version, serial: String(result.serial || ''), cloudUrl: responseCloudUrl, challenge: String(result.challenge || ''), identityFingerprint, identityGeneration }) : '';
    verified = response.ok && version === 1 && Number.isInteger(identityGeneration) && identityGeneration === identity.identityGeneration && result.ok === true && result.challenge === challenge && result.serial === serial && responseCloudUrl === cloudUrl && identityFingerprint === identity.publicKeyFingerprint && Boolean(hubSignature) && crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(hubSignature, 'base64url'));
  } catch { verified = false; }
  if (!verified) return apiFailFromStatus(409, 'The CloudURL did not complete the independent hub challenge.');
  const now = new Date();
  await prisma.$transaction(async (tx) => { await tx.hubProvisioningAttempt.update({ where: { id: attempt.id }, data: { cloudUrl, cloudUrlReportedAt: now, cloudUrlVerifiedAt: now } }); const hub = await tx.hubInstall.findUnique({ where: { serial }, select: { id: true } }); if (hub) await tx.hubInstall.update({ where: { id: hub.id }, data: { lastReportedCloudUrl: cloudUrl, lastReportedCloudUrlAt: now, cloudUrlVerifiedAt: now } }); });
  return NextResponse.json({ ok: true, verified: true, serial, verifiedAt: now.toISOString() }, { headers: { 'Cache-Control': 'no-store, private' } });
}
