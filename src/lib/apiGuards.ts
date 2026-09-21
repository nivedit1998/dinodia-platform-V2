// Architecture: Shared platform helper src/lib/apiGuards.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { NextRequest } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest, type AuthUser } from '@/lib/auth';

export async function requireUserFromRequest(req: NextRequest): Promise<AuthUser> {
  const user = await getCurrentUserFromRequest(req);
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

export function requireRole(user: AuthUser, roles: Role[]): void {
  if (!roles.includes(user.role)) throw new Error('FORBIDDEN');
}
