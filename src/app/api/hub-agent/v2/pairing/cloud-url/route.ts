import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub, canonicalCloudUrlChallenge, canonicalCloudUrlUnsignedBody } from '@/lib/stage1HubAuth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

function validCompanyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'dinodiasmartliving.com' || url.hostname.endsWith('.dinodiasmartliving.com')) && url.username === '' && url.password === '' && url.port === '';
  } catch { return false; }
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const cloudUrl = String(hub.body.cloudUrl ?? '').trim().replace(/\/$/, '');
    const hostname = String(hub.body.hostname ?? '').trim().toLowerCase();
    const tunnelId = String(hub.body.tunnelId ?? '').trim();
    const tunnelName = String(hub.body.tunnelName ?? '').trim();
    const reservationToken = String(hub.body.reservationToken ?? '').trim();
    if (!validCompanyUrl(cloudUrl) || hostname !== new URL(cloudUrl).hostname || !tunnelId || !tunnelName || !reservationToken) throw new Stage1AuthError(400, 'cloudflare_identity_invalid', 'A reserved company CloudURL, tunnel ID, tunnel name and reservation proof are required');
    const expectedHostname = String(hub.installation.reservedHostname ?? '').trim().toLowerCase();
    if (!expectedHostname || expectedHostname !== hostname) throw new Stage1AuthError(403, 'cloudflare_hostname_denied', 'The CloudURL is not the installation-reserved company hostname');
    const expectedTunnelName = String(hub.installation.reservedTunnelName ?? '').trim();
    if (!expectedTunnelName || expectedTunnelName !== tunnelName) throw new Stage1AuthError(403, 'cloudflare_tunnel_name_denied', 'The tunnel name is not reserved for this installation');
    if (!hub.installation.cloudflareReservationToken || hub.installation.cloudflareReservationToken !== reservationToken) throw new Stage1AuthError(403, 'cloudflare_reservation_denied', 'The installation reservation proof is invalid');
    if (hub.installation.cloudflareTunnelId && hub.installation.cloudflareTunnelId !== tunnelId) throw new Stage1AuthError(403, 'cloudflare_tunnel_id_denied', 'The tunnel id is not reserved for this installation');
    const publicKey = crypto.createPublicKey(hub.identity.signingPublicKey);
    const existing = await prisma.cloudUrlVerification.findFirst({ where: { hubInstallationId: hub.installation.id, tunnelId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, cloudUrl: true, reservedHostname: true, tunnelName: true, verifiedAt: true } });
    if (existing?.status === 'VERIFIED') {
      if (existing.cloudUrl !== cloudUrl || existing.reservedHostname !== hostname || existing.tunnelName !== tunnelName) throw new Stage1AuthError(409, 'cloudflare_verification_conflict', 'The tunnel identity differs from the verified installation');
      return NextResponse.json({ ok: true, verified: true, verificationId: existing.id, cloudUrl, hostname }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }
    const challenge = randomSecret(32);
    const verification = existing
      ? await prisma.cloudUrlVerification.update({ where: { id: existing.id }, data: { homeId: hub.installation.homeId, reservedHostname: hostname, tunnelName, cloudUrl, challengeHash: sha256(challenge), status: 'PENDING', expiresAt: new Date(Date.now() + 5 * 60 * 1000), failedAt: null, verifiedAt: null }, select: { id: true, expiresAt: true } })
      : await prisma.cloudUrlVerification.create({ data: { hubInstallationId: hub.installation.id, homeId: hub.installation.homeId, reservedHostname: hostname, tunnelId, tunnelName, cloudUrl, challengeHash: sha256(challenge), status: 'PENDING', expiresAt: new Date(Date.now() + 5 * 60 * 1000) }, select: { id: true, expiresAt: true } });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let remote: Response;
    try { remote = await fetch(`${cloudUrl}/_dinodia/cloud-challenge?challenge=${encodeURIComponent(challenge)}&tunnelId=${encodeURIComponent(tunnelId)}&tunnelName=${encodeURIComponent(tunnelName)}`, { headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' }); } catch { remote = new Response(null, { status: 599 }); } finally { clearTimeout(timeout); }
    const signedValue: unknown = await remote.json().catch(() => ({}));
    const signed = signedValue && typeof signedValue === 'object' && !Array.isArray(signedValue) ? signedValue as Record<string, unknown> : {};
    const expectedKeys = new Set(['ok', 'version', 'serial', 'cloudUrl', 'challenge', 'tunnelId', 'tunnelName', 'timestamp', 'bodyHash', 'identityFingerprint', 'identityGeneration', 'hubSignature']);
    const remoteShapeValid = Object.keys(signed).length === expectedKeys.size && Object.keys(signed).every((key) => expectedKeys.has(key));
    const strictTypes = signed.ok === true
      && signed.version === 1
      && ['serial', 'cloudUrl', 'challenge', 'tunnelId', 'tunnelName', 'bodyHash', 'identityFingerprint', 'hubSignature'].every((key) => typeof signed[key] === 'string' && Boolean(String(signed[key]).trim()))
      && typeof signed.timestamp === 'number'
      && Number.isSafeInteger(signed.timestamp)
      && typeof signed.identityGeneration === 'number'
      && Number.isInteger(signed.identityGeneration)
      && signed.identityGeneration >= 1;
    const responseBody = { version: 1, serial: String(signed.serial ?? ''), cloudUrl: String(signed.cloudUrl ?? ''), challenge: String(signed.challenge ?? ''), tunnelId: String(signed.tunnelId ?? ''), tunnelName: String(signed.tunnelName ?? ''), timestamp: Number(signed.timestamp), bodyHash: String(signed.bodyHash ?? ''), identityFingerprint: String(signed.identityFingerprint ?? ''), identityGeneration: Number(signed.identityGeneration) };
    const responseCanonical = canonicalCloudUrlChallenge(responseBody);
    const unsignedBodyHash = sha256(canonicalCloudUrlUnsignedBody({ serial: responseBody.serial, cloudUrl: responseBody.cloudUrl, challenge: responseBody.challenge, tunnelId: responseBody.tunnelId, tunnelName: responseBody.tunnelName, timestamp: responseBody.timestamp, identityFingerprint: responseBody.identityFingerprint, identityGeneration: responseBody.identityGeneration }));
    const now = Date.now();
    const signatureValid = remote.ok && remoteShapeValid && strictTypes && responseBody.version === 1 && responseBody.serial === hub.installation.serialNumberSnapshot && responseBody.cloudUrl === cloudUrl && responseBody.challenge === challenge && responseBody.tunnelId === tunnelId && responseBody.tunnelName === tunnelName && responseBody.timestamp <= now && responseBody.timestamp >= now - 5 * 60 * 1000 && /^[a-f0-9]{64}$/i.test(responseBody.bodyHash) && responseBody.bodyHash === unsignedBodyHash && responseBody.identityFingerprint === hub.identity.signingKeyFingerprint && responseBody.identityGeneration === hub.identity.identityGeneration && crypto.verify(null, Buffer.from(responseCanonical), publicKey, Buffer.from(String(signed.hubSignature), 'base64url'));
    if (!signatureValid) {
      await prisma.cloudUrlVerification.update({ where: { id: verification.id }, data: { status: 'FAILED', failedAt: new Date(), signedResponseDigest: signed && Object.keys(signed).length ? sha256(JSON.stringify(signed)) : null } });
      throw new Stage1AuthError(502, 'cloudflare_remote_verification_failed', 'The CloudURL did not prove the registered hub identity');
    }
    await prisma.$transaction(async (tx) => {
      await tx.cloudUrlVerification.update({ where: { id: verification.id }, data: { status: 'VERIFIED', verifiedAt: new Date(), signedResponseDigest: sha256(JSON.stringify(signed)) } });
      await tx.hubInstallation.update({ where: { id: hub.installation.id }, data: { cloudUrl, cloudflareTunnelId: tunnelId, cloudflareTunnelName: tunnelName, reservedHostname: hostname, reservedTunnelName: expectedTunnelName, cloudUrlVerifiedAt: new Date(), remoteVerificationAt: new Date() } });
    });
    return NextResponse.json({ ok: true, verified: true, verificationId: verification.id, cloudUrl, hostname }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
