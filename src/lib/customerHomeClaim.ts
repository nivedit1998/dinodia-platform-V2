import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';
import { assertClaimSessionCurrent } from './stage1ClaimContract';
import type { CustomerAccountSessionPrincipal } from './stage1Auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readCustomerClaimSetup(reservationId: string, accountId: string, principal?: CustomerAccountSessionPrincipal) {
  if (!UUID.test(reservationId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This setup is no longer available');
  return prisma.$transaction(async (tx) => {
    await assertClaimSessionCurrent(tx, principal);
    const row = await tx.homeClaimReservation.findFirst({
      where: { id: reservationId, customerAccountId: accountId },
      select: {
        id: true, state: true, expiresAt: true, setupRevision: true,
        pendingSetup: { select: { state: true, requiredStep: true, setupRevision: true, addressLine1: true, addressLine2: true, city: true, region: true, postcode: true, country: true, proposedTimezone: true } },
        claimReference: { select: { state: true, consumedAt: true, claimedAccountId: true, home: { select: { postcode: true } } } },
      },
    });
    const now = new Date();
    if (!row || !['ACTIVE','CONVERTED_TO_PENDING_INSTALLATION'].includes(row.state)
      || row.state === 'ACTIVE' && row.expiresAt <= now) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This setup is no longer available');
    return {
      schemaVersion: 'dinodia.v1' as const,
      claimId: row.id,
      state: row.pendingSetup?.state === 'ACTIVATED' && row.claimReference.state === 'CONSUMED' && row.claimReference.claimedAccountId === accountId && row.claimReference.consumedAt ? 'ACTIVE' as const : row.state === 'ACTIVE' ? 'SETUP' as const : 'INSTALLATION_PENDING' as const,
      requiredStep: row.pendingSetup?.state === 'ACTIVATED' || row.pendingSetup?.state === 'PENDING_INSTALLATION' ? null : row.pendingSetup?.requiredStep ?? null,
      revision: row.pendingSetup?.setupRevision ?? row.setupRevision,
      expiresAt: row.state === 'ACTIVE' ? row.expiresAt.toISOString() : null,
      postcode: row.claimReference.home.postcode,
      // Only the claimant's own draft values are returned. No other Home data
      // or installation/device projection crosses this boundary.
      ownDraft: row.state === 'ACTIVE' && row.pendingSetup?.state !== 'ACTIVATED' && row.pendingSetup ? {
        addressLine1: row.pendingSetup.addressLine1,
        addressLine2: row.pendingSetup.addressLine2,
        city: row.pendingSetup.city,
        region: row.pendingSetup.region,
        postcode: row.pendingSetup.postcode,
        country: row.pendingSetup.country,
        timezone: row.pendingSetup.proposedTimezone,
      } : null,
    };
  });
}
