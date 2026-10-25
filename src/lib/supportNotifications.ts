import type { Prisma } from '@prisma/client';

type NotificationEvent = 'STARTED' | 'REVOKED' | 'ENDED' | 'EXPIRED';

/**
 * Write only notifications for support that can affect property infrastructure
 * (property scope or a tenant request that explicitly targets a permanent
 * property device). The notification body is intentionally empty: recipients
 * learn that property support changed, but never receive tenant-private target
 * IDs, counts, metadata or audit detail.
 * The unique constraint makes retries and repeated revocation idempotent.
 */
export async function createPropertySupportNotifications(
  tx: Prisma.TransactionClient,
  input: { homeId: string; ticketId: string; accessRequestId: string; sessionId?: string | null; eventType: NotificationEvent },
): Promise<number> {
  const request = await tx.supportAccessRequest.findUnique({
    where: { id: input.accessRequestId },
    select: { requestedScope: true, touchesPropertyInfrastructure: true, homeId: true, ticketId: true },
  });
  if (!request || request.homeId !== input.homeId || request.ticketId !== input.ticketId || (!request.touchesPropertyInfrastructure && request.requestedScope !== 'PROPERTY_SCOPE')) return 0;

  const owners = await tx.homeMembership.findMany({
    where: { homeId: input.homeId, role: 'OWNER', status: 'ACTIVE' },
    select: { customerAccountId: true },
  });
  if (!owners.length) return 0;
  const result = await tx.supportAccessNotification.createMany({
    data: owners.map((owner) => ({
      recipientAccountId: owner.customerAccountId,
      homeId: input.homeId,
      ticketId: input.ticketId,
      accessRequestId: input.accessRequestId,
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
    })),
    skipDuplicates: true,
  });
  return result.count;
}
