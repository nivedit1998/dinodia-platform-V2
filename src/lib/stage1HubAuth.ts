import crypto from 'node:crypto';
import { prisma } from './prisma';
import { canonicalHubRequest, sha256, verifyHubSignature } from './stage1Crypto';
import { Stage1AuthError } from './stage1Auth';
import { manufacturingIdentityPayload } from './manufacturingEnrollment';

export type AuthenticatedHub = {
  installation: { id: string; homeId: string; serialNumberSnapshot: string; accessPolicyRevision: number; state: string; reservedHostname: string | null; reservedTunnelName: string | null; cloudflareTunnelId: string | null; cloudflareReservationToken: string | null };
  identity: { id: string; serialNumber: string; identityGeneration: number; signingPublicKey: string; encryptionPublicKey: string; signingKeyFingerprint: string; encryptionKeyFingerprint: string; status: string };
  body: Record<string, unknown>;
};

function jsonBody(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Stage1AuthError(400, 'invalid_hub_body', 'The hub request body is invalid');
  return parsed as Record<string, unknown>;
}

export async function authenticateHub(request: Request, rawBody: string, options: { allowIdentity?: boolean } = {}): Promise<AuthenticatedHub> {
  if (rawBody.length > 256 * 1024) throw new Stage1AuthError(413, 'hub_body_too_large', 'The hub request is too large');
  let body: Record<string, unknown>;
  try { body = jsonBody(rawBody); } catch (error) { if (error instanceof Stage1AuthError) throw error; throw new Stage1AuthError(400, 'invalid_hub_body', 'The hub request body is invalid'); }
  const serial = String(body.serial ?? '').trim();
  const generation = Number(body.identityGeneration);
  if (!serial || !Number.isInteger(generation) || generation < 1) throw new Stage1AuthError(401, 'hub_identity_missing', 'The hub identity is invalid');
  const identity = await prisma.hubManufacturingIdentity.findFirst({ where: { serialNumber: serial, identityGeneration: generation, status: 'ACTIVE' }, select: { id: true, serialNumber: true, identityGeneration: true, signingPublicKey: true, encryptionPublicKey: true, signingKeyFingerprint: true, encryptionKeyFingerprint: true, status: true } });
  if (!identity) throw new Stage1AuthError(401, 'hub_identity_revoked', 'The hub identity is not active');
  const installation = await prisma.hubInstallation.findUnique({ where: { serialNumberSnapshot: serial }, select: { id: true, homeId: true, serialNumberSnapshot: true, accessPolicyRevision: true, state: true, reservedHostname: true, reservedTunnelName: true, cloudflareTunnelId: true, cloudflareReservationToken: true } });
  if (!installation) throw new Stage1AuthError(409, 'hub_not_provisioned', 'The hub is not linked to an installation');
  const machineVersion = Number(request.headers.get('x-dinodia-machine-version') ?? '0');
  const machineSignature = request.headers.get('x-dinodia-machine-signature') ?? '';
  if (Number.isInteger(machineVersion) && machineVersion > 0 && machineSignature) {
    const credential = await prisma.hubCredentialVersion.findFirst({ where: { hubInstallationId: installation.id, purpose: 'machine-credential', version: machineVersion, state: { in: ['ACTIVE', 'GRACE'] } }, select: { tokenHash: true, graceUntil: true } });
    if (!credential || (credential.graceUntil && credential.graceUntil <= new Date())) throw new Stage1AuthError(401, 'machine_credential_invalid', 'The hub machine credential is not active');
    const timestamp = request.headers.get('x-dinodia-hub-timestamp') ?? '';
    const nonce = request.headers.get('x-dinodia-hub-nonce') ?? '';
    const suppliedBodyHash = request.headers.get('x-dinodia-body-sha256') ?? sha256(rawBody);
    const expected = crypto.createHmac('sha256', credential.tokenHash).update(canonicalHubRequest({ method: request.method, path: new URL(request.url).pathname, timestamp, nonce, bodyHash: suppliedBodyHash }), 'utf8').digest('base64url');
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(machineSignature);
    if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer) || !verifyMachineTimestamp(timestamp, suppliedBodyHash, rawBody)) throw new Stage1AuthError(401, 'machine_signature_invalid', 'The hub machine signature is invalid');
  } else if (options.allowIdentity) {
    let publicKey: crypto.KeyObject;
    try { publicKey = crypto.createPublicKey(identity.signingPublicKey); } catch { throw new Stage1AuthError(401, 'hub_key_invalid', 'The hub signing identity is invalid'); }
    if (!verifyHubSignature(rawBody, request, publicKey)) throw new Stage1AuthError(401, 'hub_signature_invalid', 'The hub signature is invalid');
  } else {
    throw new Stage1AuthError(401, 'machine_credential_required', 'The acknowledged hub machine credential is required');
  }
  const nonce = String(request.headers.get('x-dinodia-hub-nonce') ?? '');
  const bodyHash = sha256(rawBody);
  try {
    await prisma.replayNonce.create({ data: { principalKind: 'HUB', principalId: identity.id, nonceHash: sha256(nonce), requestDigest: bodyHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
  } catch {
    throw new Stage1AuthError(401, 'hub_nonce_replayed', 'The hub request has already been used');
  }
  return { installation, identity, body };
}

function verifyMachineTimestamp(timestamp: string, suppliedBodyHash: string, rawBody: string): boolean {
  const numeric = Number(timestamp);
  return Boolean(timestamp && Number.isSafeInteger(numeric) && Math.abs(Date.now() - numeric) <= 5 * 60 * 1000 && suppliedBodyHash === sha256(rawBody));
}

export function canonicalCloudUrlBody(input: { serial: string; identityGeneration: number; hubInstallationId: string; tunnelId: string; tunnelName: string; hostname: string; cloudUrl: string; nonce: string; timestamp: number; bodyHash: string }): string {
  return JSON.stringify({ version: 1, ...input });
}

/** Byte-stable payload signed by Dinodia OS before a trusted-phone challenge. */
export function canonicalStepUpDescriptor(input: Record<string, unknown>): string {
  return JSON.stringify({
    version: Number(input.version), serial: String(input.serial), identityGeneration: Number(input.identityGeneration),
    actorId: String(input.actorId), customerSessionId: String(input.customerSessionId), trustedDeviceId: String(input.trustedDeviceId),
    homeId: String(input.homeId), membershipId: String(input.membershipId), hubInstallId: String(input.hubInstallId),
    operationKind: String(input.operationKind), targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(String) : [],
    controlId: String(input.controlId), descriptorRevision: Number(input.descriptorRevision), descriptorDigest: input.descriptorDigest == null ? null : String(input.descriptorDigest),
    operationDigest: String(input.operationDigest), nonce: String(input.nonce), issuedAt: Number(input.issuedAt),
  });
}

export function signedBodyDigest(input: Record<string, unknown>): string {
  return sha256(JSON.stringify(input));
}

export function rootSignatureInput(body: Record<string, unknown>): string {
  // The root signs the stable manufacturing certificate, not a later
  // provisioning attempt.  Attempt IDs, BaseURLs and expiry timestamps are
  // hub-signed separately and must not make a factory certificate impossible
  // to reuse for the same enrolled identity generation.
  return manufacturingIdentityPayload(body as never);
}

export function verifyManufacturingRoot(body: Record<string, unknown>): boolean {
  // The imaging service historically called this certificate field
  // `manufacturingSignature`; accept that exact registered-identity field as
  // an alias, but verify it against the configured manufacturing root. Never
  // treat a hub signature or a caller-provided certificate as a root key.
  const signature = String(body.manufacturingRootSignature ?? body.manufacturingSignature ?? '');
  const keys = String(process.env.MANUFACTURING_ROOT_PUBLIC_KEYS ?? '').replaceAll('\\n', '\n').match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? [];
  if (!signature || keys.length === 0) return false;
  return keys.some((pem) => {
    try { return crypto.verify(null, Buffer.from(rootSignatureInput(body)), crypto.createPublicKey(pem), Buffer.from(signature, 'base64url')); } catch { return false; }
  });
}

export function verifyHubBodySignature(body: Record<string, unknown>, publicKey: crypto.KeyObject): boolean {
  const signature = String(body.hubSignature ?? '');
  if (!signature) return false;
  const copy = { ...body };
  delete copy.hubSignature;
  try { return crypto.verify(null, Buffer.from(JSON.stringify(copy)), publicKey, Buffer.from(signature, 'base64url')); } catch { return false; }
}

/** Verify the JSON envelope signature used before a Platform identity row exists. */
export function verifyEmbeddedHubSignature(body: Record<string, unknown>, publicKey: crypto.KeyObject): boolean {
  const signature = String(body.hubSignature ?? '');
  if (!signature) return false;
  const copy = { ...body };
  delete copy.hubSignature;
  delete copy.manufacturingSignature;
  delete copy.manufacturingRootSignature;
  try { return crypto.verify(null, Buffer.from(JSON.stringify(copy)), publicKey, Buffer.from(signature, 'base64url')); } catch { return false; }
}

export function canonicalRequestForAudit(request: Request, body: string): string {
  return canonicalHubRequest({ method: request.method, path: new URL(request.url).pathname, timestamp: request.headers.get('x-dinodia-hub-timestamp') ?? '', nonce: request.headers.get('x-dinodia-hub-nonce') ?? '', bodyHash: sha256(body) });
}
