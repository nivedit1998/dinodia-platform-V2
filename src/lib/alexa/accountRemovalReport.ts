import { Prisma } from '@prisma/client';

export const ALEXA_ACCOUNT_REMOVAL_AGGREGATE = 'AlexaAccountRemoval';
export const ALEXA_ACCOUNT_REMOVAL_EVENT = 'ALEXA_ACCOUNT_REMOVAL_REPORT';
const ENDPOINT_ID = /^dos_[A-Za-z0-9_-]{16,80}$/;
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENDPOINTS = 5000;

/**
 * Deleting a customer account cascades away its Alexa link, and with it the only means of telling Amazon the devices are
 * gone, so the tenant's Alexa app would keep listing dead devices. Call this inside the deleting transaction, before the
 * delete: it parks what is needed for one final DeleteReport (the link's already-encrypted refresh token and the endpoint
 * ids Alexa was told about) as an outbox row that the two-minute operations tick delivers and then wipes. No new table.
 */
export async function queueAlexaRemovalReportsForAccount(tx: Prisma.TransactionClient, accountId: string, now: Date): Promise<number> {
  const links = await tx.alexaNativeLink.findMany({ where: { customerAccountId: accountId, status: 'ACTIVE', revokedAt: null,
    refreshTokenCiphertext: { not: null } }, select: { id: true, refreshTokenCiphertext: true, announcedEndpointIds: true } });
  let queued = 0;
  for (const link of links) {
    const endpointIds = (Array.isArray(link.announcedEndpointIds) ? link.announcedEndpointIds : [])
      .filter((item): item is string => typeof item === 'string' && ENDPOINT_ID.test(item)).slice(-MAX_ENDPOINTS);
    if (!link.refreshTokenCiphertext || endpointIds.length === 0) continue;
    const idempotencyKey = `alexa-account-removal:${link.id}`;
    await tx.nativeDomainOutbox.upsert({ where: { idempotencyKey }, create: {
      homeId: null, hubInstallationId: null, aggregateType: ALEXA_ACCOUNT_REMOVAL_AGGREGATE, aggregateId: link.id,
      eventType: ALEXA_ACCOUNT_REMOVAL_EVENT, idempotencyKey,
      payload: { refreshTokenCiphertext: link.refreshTokenCiphertext, endpointIds },
      nextAttemptAt: now, expiresAt: new Date(now.getTime() + RETRY_WINDOW_MS),
    }, update: {} });
    queued += 1;
  }
  return queued;
}

/**
 * An Alexa link exists to follow a tenant's rooms. When the tenant no longer has any Home (removed by an owner, left on
 * their own, a Home deregistered), the link only holds dead tokens, so it is retired: a final DeleteReport is parked for
 * the devices Alexa still lists, then the link, its OAuth tokens, scopes and endpoints are revoked and the stored Amazon
 * tokens are wiped. The account itself is untouched; once they have a Home again they simply link Alexa again.
 * Call inside a transaction. Returns true when a link was retired.
 */
export async function retireAlexaLinksWithoutHomes(tx: Prisma.TransactionClient, accountId: string, now: Date): Promise<boolean> {
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${accountId}::uuid FOR UPDATE`;
  const stillHasHome = await tx.homeMembership.count({ where: { customerAccountId: accountId, role: 'TENANT', status: { in: ['ACTIVE', 'REMOVAL_PENDING'] } } });
  if (stillHasHome > 0) return false;
  const links = await tx.alexaNativeLink.findMany({ where: { customerAccountId: accountId, status: 'ACTIVE', revokedAt: null }, select: { id: true } });
  if (links.length === 0) return false;
  for (const link of links) await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${link.id}::uuid FOR UPDATE`;
  await queueAlexaRemovalReportsForAccount(tx, accountId, now);
  for (const link of links) {
    await tx.alexaNativeAreaSelection.updateMany({ where: { homeScope: { linkId: link.id }, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
    await tx.alexaNativeHomeScope.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now, updatedAt: now } });
    await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: now } });
    await tx.alexaOAuthTokenFamily.updateMany({ where: { linkId: link.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'no_homes' } });
    await tx.alexaOAuthAccessToken.updateMany({ where: { family: { linkId: link.id }, revokedAt: null }, data: { revokedAt: now } });
    await tx.alexaOAuthRefreshToken.updateMany({ where: { family: { linkId: link.id }, revokedAt: null }, data: { revokedAt: now } });
    await tx.alexaNativeLink.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: now, revision: { increment: 1 },
      accessTokenCiphertext: null, refreshTokenCiphertext: null, announcedEndpointIds: Prisma.DbNull, updatedAt: now } });
  }
  return true;
}
