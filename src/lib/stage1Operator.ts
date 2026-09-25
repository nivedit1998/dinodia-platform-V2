import crypto from 'node:crypto';
import { encryptToHubKey } from './hubOperatorCredentials';

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }

export function supportRedeemDigest(input: { serial: string; ticketId: string; requestId: string; code: string; identityGeneration: number }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    serial: String(input.serial),
    ticketId: String(input.ticketId),
    requestId: String(input.requestId),
    code: String(input.code),
    identityGeneration: Number(input.identityGeneration),
  }), 'utf8').digest('hex');
}

export function createHubBoundOperatorGrant(input: { employeeId: string; hubId: string; workflowId: string; scope: string[]; areaIds?: string[]; recentAuthAt: number; expiresAt: number; credentialVersion?: number; requestId?: string; homeId?: string; identityGeneration?: number; requestBodyDigest?: string }): string {
  const privatePem = String(process.env.OPERATOR_SESSION_PRIVATE_KEY ?? '');
  if (!privatePem) throw new Error('OPERATOR_SESSION_PRIVATE_KEY is required');
  const privateKey = crypto.createPrivateKey(privatePem.replaceAll('\\n', '\n'));
  const issuedAt = Math.floor(Date.now() / 1000);
  const exp = Math.min(Math.floor(input.expiresAt / 1000), issuedAt + 15 * 60);
  const payload = { iss: 'dinodia-platform', aud: `dinodia-os:${input.hubId}`, sub: input.employeeId, sid: crypto.randomUUID(), jti: crypto.randomUUID(), hubId: input.hubId, scope: [...new Set(input.scope)], iat: issuedAt, exp, recentAuthAt: input.recentAuthAt, workflow: input.workflowId, credentialVersion: Number(input.credentialVersion || 0), ...(input.areaIds ? { areaIds: [...new Set(input.areaIds)] } : {}), ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.homeId ? { homeId: input.homeId } : {}), ...(input.identityGeneration ? { identityGeneration: Number(input.identityGeneration) } : {}), ...(input.requestBodyDigest ? { requestBodyDigest: input.requestBodyDigest } : {}) };
  if (!payload.scope.length) throw new Error('operator scope is required');
  const header = { alg: 'EdDSA', typ: 'DNO-OPS-1' };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `dno1.${signingInput}.${crypto.sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

export function encryptOperatorGrant(grant: string, hubEncryptionPublicKey: string, version = 1, purpose = 'operator-session') {
  return encryptToHubKey(grant, hubEncryptionPublicKey, purpose, version);
}

export function verifyHubBoundOperatorGrant(token: string, input: { hubId: string; workflowId: string; requiredScope: string; employeeId?: string; requestId?: string; homeId?: string; identityGeneration?: number; requestBodyDigest?: string }, now = Date.now()): Record<string, unknown> | null {
  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== 'dno1') return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'));
  } catch { return null; }
  if (header.alg !== 'EdDSA' || header.typ !== 'DNO-OPS-1' || payload.iss !== 'dinodia-platform') return null;
  const privatePem = String(process.env.OPERATOR_SESSION_PRIVATE_KEY ?? '');
  if (!privatePem) return null;
  try {
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey(privatePem.replaceAll('\\n', '\n')));
    if (!crypto.verify(null, Buffer.from(`${parts[1]}.${parts[2]}`), publicKey, Buffer.from(parts[3], 'base64url'))) return null;
  } catch { return null; }
  const nowSeconds = Math.floor(now / 1000);
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  const recentAuthAt = Number(payload.recentAuthAt);
  const scopes = Array.isArray(payload.scope) ? payload.scope.map(String) : [];
  if (!payload.sub || !payload.sid || !payload.jti || payload.hubId !== input.hubId || payload.workflow !== input.workflowId || !scopes.includes(input.requiredScope) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= nowSeconds || exp - iat > 15 * 60 || !Number.isFinite(recentAuthAt) || now - recentAuthAt > 5 * 60 * 1000) return null;
  if (input.employeeId && payload.sub !== input.employeeId) return null;
  if (input.requestId && payload.requestId !== input.requestId) return null;
  if (input.homeId && payload.homeId !== input.homeId) return null;
  if (input.identityGeneration != null && Number(payload.identityGeneration) !== Number(input.identityGeneration)) return null;
  if (input.requestBodyDigest && payload.requestBodyDigest !== input.requestBodyDigest) return null;
  return payload;
}
