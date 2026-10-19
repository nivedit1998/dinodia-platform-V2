import { Prisma } from '@prisma/client';
import type { requireCustomerSelectedHome } from './customerSelectedHome';
import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { readTenantDeviceDashboard, TenantDeviceDashboardDenied } from './tenantDeviceDashboard';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SelectedHome = Awaited<ReturnType<typeof requireCustomerSelectedHome>>;

/**
 * Reads the tenant's live dashboard projection for a Home the caller has
 * ALREADY authenticated with requireCustomerSelectedHome. Callers must not
 * re-run that check: the membership and session lookups are the expensive part
 * of each request, and repeating them doubled the latency seen by the phone.
 *
 * The read is a RepeatableRead transaction, so every query sees one snapshot.
 * It only reads, so it cannot hit a serialization conflict and needs no retry.
 */
export async function readTenantDeviceContextForSelectedHome(selected: SelectedHome, homeId: string) {
  if (!uuid.test(homeId) || selected.homeId !== homeId || selected.role !== 'TENANT'
    || selected.credentialKind !== 'account_access') {
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant device context is not available to the selected account');
  }
  return prisma.$transaction((tx: Prisma.TransactionClient) => readTenantDeviceDashboard(tx, {
    accountId: selected.id,
    sessionId: selected.sessionId,
    trustedDeviceId: selected.trustedDeviceId,
    tokenHash: selected.tokenHash,
    credentialKind: 'account_access',
    homeId,
    membershipId: selected.membershipId,
    hubInstallationId: selected.hubInstallationId,
  }), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    // The hub gives Platform 15 s and the phone 20 s; keep Platform inside both.
    maxWait: 2000,
    timeout: 10000,
  });
}

/** Maps dashboard denials to the same public errors the canonical route has always returned. */
export function mapTenantDeviceContextError(error: unknown): unknown {
  if (!(error instanceof TenantDeviceDashboardDenied)) return error;
  return error.code === 'SESSION_REVOKED'
    ? new Stage1AuthError(401, 'customer_session_invalid', 'The customer session is no longer active')
    : new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Tenant device context is not available to the selected account');
}
