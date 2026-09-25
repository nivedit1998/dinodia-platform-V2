import crypto from 'node:crypto';

export type Stage1TokenKind = 'employee' | 'customer';

export type Stage1Principal = {
  kind: Stage1TokenKind;
  issuer: string;
  audience: string;
  id: string;
  sessionId: string;
  homeId?: string;
  membershipId?: string;
  trustedDeviceId?: string;
  hubInstallationId?: string;
  role?: 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
  areaIds: string[];
  scopes: string[];
  policyRevision: number;
  issuedAt: number;
  expiresAt: number;
  recentAuthenticatedAt?: number;
};

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('token payload is invalid');
  return parsed as Record<string, unknown>;
}

export function parsePublicKeys(value: string | undefined): crypto.KeyObject[] {
  const source = String(value ?? '').replaceAll('\\n', '\n').trim();
  if (!source) return [];
  const entries = source.includes('-----BEGIN')
    ? (source.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? [])
    : source.split(/\s*,\s*|\n+/);
  return entries.flatMap((entry) => {
    try {
      return [crypto.createPublicKey(entry.trim())];
    } catch {
      return [];
    }
  });
}

export function signStage1Token(
  kind: Stage1TokenKind,
  claims: Omit<Stage1Principal, 'kind' | 'issuer' | 'audience'>,
  privateKey: crypto.KeyObject,
): string {
  const header = { alg: 'EdDSA', typ: kind === 'employee' ? 'DNO-EMP-1' : 'DNO-APP-1', v: 1 };
  const payload = {
    iss: 'dinodia-platform-v2',
    aud: kind === 'employee' ? 'dinodia-company-portal' : `dinodia-hub:${claims.hubInstallationId ?? ''}`,
    sub: claims.id,
    sid: claims.sessionId,
    jti: randomSecret(24),
    homeId: claims.homeId,
    membershipId: claims.membershipId,
    trustedDeviceId: claims.trustedDeviceId,
    hubInstallationId: claims.hubInstallationId,
    householdRole: claims.role,
    areaIds: [...new Set(claims.areaIds.map(String))],
    scope: [...new Set(claims.scopes.map(String))],
    policyRevision: claims.policyRevision,
    iat: claims.issuedAt,
    exp: claims.expiresAt,
    ...(claims.recentAuthenticatedAt ? { recentAuthenticatedAt: claims.recentAuthenticatedAt } : {}),
  };
  const encodedHeader = encode(header);
  const encodedPayload = encode(payload);
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign(null, Buffer.from(input), privateKey).toString('base64url');
  return `${kind === 'employee' ? 'dno-employee-1' : 'dno-app-1'}.${input}.${signature}`;
}

export function verifyStage1Token(
  token: string,
  kind: Stage1TokenKind,
  publicKeys: crypto.KeyObject[],
  now = Date.now(),
  maxLifetimeSeconds = kind === 'employee' ? 8 * 60 * 60 : 300,
): Stage1Principal | null {
  const parts = String(token ?? '').split('.');
  const expectedPrefix = kind === 'employee' ? 'dno-employee-1' : 'dno-app-1';
  if (parts.length !== 4 || parts[0] !== expectedPrefix || publicKeys.length === 0) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decode(parts[1]);
    payload = decode(parts[2]);
  } catch {
    return null;
  }
  const expectedType = kind === 'employee' ? 'DNO-EMP-1' : 'DNO-APP-1';
  if (header.alg !== 'EdDSA' || header.typ !== expectedType || header.v !== 1 || payload.iss !== 'dinodia-platform-v2') return null;
  const valid = publicKeys.some((key) => {
    try {
      return crypto.verify(null, Buffer.from(`${parts[1]}.${parts[2]}`), key, Buffer.from(parts[3], 'base64url'));
    } catch {
      return false;
    }
  });
  if (!valid) return null;
  const nowSeconds = Math.floor(now / 1000);
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt > nowSeconds + 5 || expiresAt <= nowSeconds || expiresAt - issuedAt > maxLifetimeSeconds) return null;
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.jti !== 'string') return null;
  if (typeof payload.aud !== 'string' || !payload.aud) return null;
  const areas = Array.isArray(payload.areaIds) ? payload.areaIds.map(String) : [];
  const scopes = Array.isArray(payload.scope) ? payload.scope.map(String) : [];
  const role = payload.householdRole === 'OWNER' || payload.householdRole === 'PROPERTY_MANAGER' || payload.householdRole === 'TENANT' ? payload.householdRole : undefined;
  if (kind === 'customer' && !role) return null;
  return {
    kind,
    issuer: String(payload.iss),
    audience: String(payload.aud),
    id: payload.sub,
    sessionId: payload.sid,
    homeId: typeof payload.homeId === 'string' ? payload.homeId : undefined,
    membershipId: typeof payload.membershipId === 'string' ? payload.membershipId : undefined,
    trustedDeviceId: typeof payload.trustedDeviceId === 'string' ? payload.trustedDeviceId : undefined,
    hubInstallationId: typeof payload.hubInstallationId === 'string' ? payload.hubInstallationId : undefined,
    role,
    areaIds: [...new Set(areas)],
    scopes: [...new Set(scopes)],
    policyRevision: Number.isInteger(payload.policyRevision) ? Number(payload.policyRevision) : 0,
    issuedAt,
    expiresAt,
    recentAuthenticatedAt: Number.isFinite(Number(payload.recentAuthenticatedAt)) ? Number(payload.recentAuthenticatedAt) : undefined,
  };
}

export function headerToken(request: Request, header: string): string {
  const direct = request.headers.get(header);
  if (direct) return direct.trim();
  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function canonicalHubRequest({ method, path, timestamp, nonce, bodyHash }: { method: string; path: string; timestamp: string | number; nonce: string; bodyHash: string }): string {
  return [String(method).toUpperCase(), String(path), String(timestamp), String(nonce), String(bodyHash).toLowerCase()].join('\n');
}

export function verifyHubSignature(body: string, request: Request, publicKey: crypto.KeyObject, now = Date.now()): boolean {
  const timestamp = request.headers.get('x-dinodia-hub-timestamp') ?? '';
  const nonce = request.headers.get('x-dinodia-hub-nonce') ?? '';
  const signature = request.headers.get('x-dinodia-hub-signature') ?? '';
  const suppliedBodyHash = request.headers.get('x-dinodia-body-sha256') ?? sha256(body);
  const timestampNumber = Number(timestamp);
  if (!signature || !nonce || !Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > 5 * 60 * 1000 || suppliedBodyHash !== sha256(body)) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalHubRequest({ method: request.method, path: new URL(request.url).pathname, timestamp, nonce, bodyHash: suppliedBodyHash }), 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
