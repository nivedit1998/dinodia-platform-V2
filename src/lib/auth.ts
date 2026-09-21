// Architecture: Shared platform helper src/lib/auth.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from './prisma';
import { Role } from '@prisma/client';

const JWT_COOKIE_NAME = 'dinodia_token';

export type AuthUser = {
  id: number;
  username: string;
  role: Role;
};

export type InstallerImpersonationScope = 'IMPERSONATE_USER';

export type ImpersonationMeta = {
  installerUserId: number;
  supportRequestId: string;
  installerDeviceId: string;
  scope: InstallerImpersonationScope;
  issuedAt: string;
  expiresAt: string;
};

export type AuthClaims = AuthUser & {
  impersonation?: ImpersonationMeta;
  recentAuthAt?: number;
  exp?: number;
};

export type CredentialAuthFailureReason = 'USERNAME_NOT_FOUND' | 'INVALID_PASSWORD' | 'EMAIL_NOT_UNIQUE';

export type CredentialAuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: CredentialAuthFailureReason };

type KioskTokenClaims = AuthUser & {
  kind: 'KIOSK';
  deviceId: string;
  sessionVersion: number;
};

const JWT_SECRET = process.env.JWT_SECRET!;
if (!JWT_SECRET) throw new Error('JWT_SECRET not set');

async function findAuthUserById(id: number): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, role: true, isActive: true },
  });
  if (!user || user.isActive === false) return null;
  return { id: user.id, username: user.username, role: user.role };
}

export async function getUserFromToken(token: string | null | undefined): Promise<AuthUser | null> {
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    return await findAuthUserById(payload.id);
  } catch {
    return null;
  }
}

function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function getUserFromAuthorizationHeader(authHeader: string | null | undefined) {
  return getUserFromToken(extractBearerToken(authHeader));
}

export async function hashPassword(password: string) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function createToken(user: AuthUser) {
  return jwt.sign({ ...user, recentAuthAt: Date.now() }, JWT_SECRET, { expiresIn: '7d' });
}

export function createTokenWithExpiry(user: AuthUser, expiresInSeconds: number, impersonation?: ImpersonationMeta) {
  const payload: AuthClaims = impersonation ? { ...user, impersonation, recentAuthAt: Date.now() } : { ...user, recentAuthAt: Date.now() };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSeconds });
}

export function createKioskToken(user: AuthUser, deviceId: string, sessionVersion: number) {
  const claims: KioskTokenClaims = {
    ...user,
    kind: 'KIOSK',
    deviceId,
    sessionVersion,
  };
  // No explicit expiresIn; revocation handled via sessionVersion + device status.
  return jwt.sign(claims, JWT_SECRET);
}

export async function setAuthCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

export async function setAuthCookieWithTtl(token: string, maxAgeSeconds: number) {
  const cookieStore = await cookies();
  cookieStore.set(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export async function clearAuthCookie() {
  const cookieStore = await cookies();
  cookieStore.set(JWT_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(JWT_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    // Make sure user still exists
    return await findAuthUserById(payload.id);
  } catch {
    return null;
  }
}

export async function authenticateWithCredentials(username: string, password: string): Promise<AuthUser | null> {
  const result = await authenticateWithCredentialsDetailed(username, password);
  return result.ok ? result.user : null;
}

export async function authenticateWithCredentialsDetailed(
  username: string,
  password: string,
  options?: { expectedRole?: import('@prisma/client').Role | null }
): Promise<CredentialAuthResult> {
  const identifier = typeof username === 'string' ? username.trim() : '';
  if (!identifier || !password) {
    return { ok: false, reason: 'USERNAME_NOT_FOUND' };
  }

  const normalized = identifier.toLowerCase();
  const isEmail = normalized.includes('@');
  const expectedRole = options?.expectedRole ?? null;

  const user = isEmail
    ? await (async () => {
        const matches = await prisma.user.findMany({
          where: {
            ...(expectedRole ? { role: expectedRole } : {}),
            OR: [
              { email: { equals: identifier, mode: 'insensitive' } },
              { emailPending: { equals: identifier, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            username: true,
            role: true,
            isActive: true,
            passwordHash: true,
          },
        });
        if (matches.length === 0) return null;
        if (matches.length > 1) {
          return { ambiguous: true as const };
        }
        return matches[0];
      })()
    : await prisma.user.findFirst({
        where: { username: { equals: identifier, mode: 'insensitive' } },
        select: {
          id: true,
          username: true,
          role: true,
          isActive: true,
          passwordHash: true,
        },
      });

  if (!user) {
    return { ok: false, reason: 'USERNAME_NOT_FOUND' };
  }
  if ('ambiguous' in user) {
    return { ok: false, reason: 'EMAIL_NOT_UNIQUE' };
  }
  if (user.isActive === false) {
    return { ok: false, reason: 'USERNAME_NOT_FOUND' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, reason: 'INVALID_PASSWORD' };
  }

  return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
}

export async function createSessionForUser(user: AuthUser) {
  const token = createToken(user);
  await setAuthCookie(token);
}

export async function getCurrentUserFromRequest(req: NextRequest): Promise<AuthUser | null> {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return getUserFromAuthorizationHeader(authHeader);
  }
  return getCurrentUser();
}

export function createTokenForUser(user: AuthUser): string {
  return createToken(user);
}

export async function getKioskAuthFromRequest(
  req: NextRequest
): Promise<{ user: AuthUser; deviceId: string; sessionVersion: number } | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.toLowerCase().startsWith('bearer ')) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as KioskTokenClaims;
    if (payload.kind !== 'KIOSK') return null;
    const user = await findAuthUserById(payload.id);
    if (!user) return null;
    return {
      user,
      deviceId: payload.deviceId,
      sessionVersion: Number(payload.sessionVersion ?? 0),
    };
  } catch {
    return null;
  }
}

export async function getJwtClaimsFromRequest(req: NextRequest): Promise<AuthClaims | null> {
  const authHeader = req.headers.get('authorization');
  let token: string | null = null;
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    token = authHeader.replace(/^Bearer\s+/i, '').trim();
  } else {
    token = (await cookies()).get(JWT_COOKIE_NAME)?.value ?? null;
  }
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as AuthClaims;
  } catch {
    return null;
  }
}
