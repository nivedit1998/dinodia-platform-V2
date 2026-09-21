// Architecture: Shared platform helper src/lib/installerSupportScope.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { NextRequest } from 'next/server';
import {
  getJwtClaimsFromRequest,
  ImpersonationMeta,
  InstallerImpersonationScope,
} from './auth';

export const INSTALLER_IMPERSONATION_SCOPE: InstallerImpersonationScope = 'IMPERSONATE_USER';

function parseIsoTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInstallerScope(value: unknown): value is InstallerImpersonationScope {
  return value === INSTALLER_IMPERSONATION_SCOPE;
}

export function isScopeAllowedForImpersonation(
  value: unknown,
  expectedScope: InstallerImpersonationScope = INSTALLER_IMPERSONATION_SCOPE
): value is InstallerImpersonationScope {
  return value === expectedScope;
}

export function isInstallerImpersonationMeta(value: unknown): value is ImpersonationMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<ImpersonationMeta>;
  if (!Number.isInteger(meta.installerUserId) || (meta.installerUserId ?? 0) <= 0) return false;
  if (typeof meta.supportRequestId !== 'string' || meta.supportRequestId.trim().length === 0) return false;
  if (typeof meta.installerDeviceId !== 'string' || meta.installerDeviceId.trim().length === 0) return false;
  if (typeof meta.issuedAt !== 'string' || parseIsoTimestamp(meta.issuedAt) === null) return false;
  if (typeof meta.expiresAt !== 'string' || parseIsoTimestamp(meta.expiresAt) === null) return false;
  if (!isInstallerScope(meta.scope)) return false;
  return true;
}

export function isInstallerImpersonationActive(
  impersonation: ImpersonationMeta,
  now: Date = new Date()
): boolean {
  const nowMs = now.getTime();
  const issuedAtMs = parseIsoTimestamp(impersonation.issuedAt);
  const expiresAtMs = parseIsoTimestamp(impersonation.expiresAt);
  if (issuedAtMs === null || expiresAtMs === null) return false;
  if (issuedAtMs > nowMs + 5_000) return false;
  if (expiresAtMs <= nowMs) return false;
  return true;
}

export async function getActiveInstallerImpersonation(
  req: NextRequest,
  requiredScope: InstallerImpersonationScope | null = null
): Promise<ImpersonationMeta | null> {
  const claims = await getJwtClaimsFromRequest(req);
  if (!isInstallerImpersonationMeta(claims?.impersonation)) {
    return null;
  }
  if (!isInstallerImpersonationActive(claims.impersonation)) {
    return null;
  }
  if (requiredScope && claims.impersonation.scope !== requiredScope) {
    return null;
  }
  return claims.impersonation;
}
