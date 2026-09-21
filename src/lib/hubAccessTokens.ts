import crypto from 'node:crypto';

export type HubAccessClaims = {
  iss: 'dinodia-platform';
  aud: `dinodia-hub:${string}`;
  sub: `user:${number}`;
  sid: string;
  membershipId: string;
  trustedDeviceId: string;
  hubInstallId: string;
  homeId: number;
  householdRole: 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
  areaIds: string[];
  policyRevision: number;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export function createHubAccessKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

export function signHubAccessToken(claims: HubAccessClaims, privateKey: crypto.KeyObject) {
  validateHubAccessClaims(claims, Date.now());
  const header = { alg: 'EdDSA', typ: 'DNO-APP-1' };
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign(null, Buffer.from(input), privateKey).toString('base64url');
  return `dno-app-1.${input}.${signature}`;
}

export function createHubAccessToken(claims: Omit<HubAccessClaims, 'iat' | 'exp' | 'jti'> & { expiresInSeconds?: number; now?: number }, privateKey: crypto.KeyObject) {
  const now = claims.now ?? Date.now();
  const ttlSeconds = Math.min(Math.max(Number(claims.expiresInSeconds ?? 300), 1), 300);
  const base = { ...claims } as Omit<HubAccessClaims, 'iat' | 'exp' | 'jti'> & { expiresInSeconds?: number; now?: number };
  delete base.expiresInSeconds;
  delete base.now;
  return signHubAccessToken({ ...base, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds, jti: crypto.randomUUID() }, privateKey);
}

export function serializePublicKeySet(keys: Array<{ id: string; publicKey: crypto.KeyObject }>) {
  return keys.map(({ id, publicKey }) => ({ id, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }));
}

export function validateHubAccessClaims(claims: Partial<HubAccessClaims>, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  if (claims.iss !== 'dinodia-platform' || typeof claims.aud !== 'string' || !claims.aud.startsWith('dinodia-hub:')) throw new Error('Invalid hub token issuer or audience');
  if (!claims.sub || !/^user:\d+$/.test(claims.sub)) throw new Error('Invalid hub token subject');
  if (!claims.sid || !claims.jti || !claims.membershipId || !claims.trustedDeviceId || !claims.hubInstallId || !Array.isArray(claims.areaIds) || !Array.isArray(claims.scope)) throw new Error('Incomplete hub token claims');
  if (!Number.isInteger(claims.homeId) || !Number.isInteger(claims.policyRevision)) throw new Error('Invalid hub token home/policy claims');
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= nowSeconds || expiresAt - issuedAt > 5 * 60) throw new Error('Hub token is expired or exceeds the five-minute TTL');
  return true;
}
