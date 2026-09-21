// Architecture: Shared platform helper src/lib/passwordResetRoles.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Role } from '@prisma/client';

export type PasswordResetRole = 'TENANT' | 'ADMIN';

export function normalizePasswordResetRole(value: unknown): PasswordResetRole | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'TENANT' || normalized === 'ADMIN') return normalized;
  return null;
}

export function passwordResetRoleToPrismaRole(role: PasswordResetRole): Role {
  return role === 'TENANT' ? Role.TENANT : Role.ADMIN;
}

export function passwordResetRoleLabel(role: PasswordResetRole): string {
  return role === 'TENANT' ? 'tenant' : 'homeowner';
}
