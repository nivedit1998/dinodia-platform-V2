import { Prisma } from '@prisma/client';

/** Exact identity pruning; never a room-name match or whole-Home deletion. */
export function pruneDeletedReferences(value: unknown, references: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return references.has(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(item => pruneDeletedReferences(item, references)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  // An attributable record is removed as a unit, including sibling fields such
  // as a value or device name, rather than merely hiding its identity field.
  const identityKeys = new Set(['id', 'areaId', 'osAreaId', 'deviceId', 'osDeviceId', 'entityId', 'targetId']);
  if (entries.some(([key, item]) => identityKeys.has(key) && typeof item === 'string' && references.has(item))) return undefined;
  return Object.fromEntries(entries.filter(([key]) => !references.has(key)).map(([key, item]) =>
    [key, pruneDeletedReferences(item, references)]).filter(([, item]) => item !== undefined));
}

export async function purgeAreaPayloads(tx: Prisma.TransactionClient, input: {
  homeId: string; areaId: string; osAreaId: string; deviceIds: string[]; osDeviceIds: string[]; operationRowId: string;
}) {
  const references = new Set([input.areaId, input.osAreaId, ...input.deviceIds, ...input.osDeviceIds]);
  const refs = [...references];
  const matches = (column: Prisma.Sql) => Prisma.sql`EXISTS (SELECT 1 FROM unnest(ARRAY[${Prisma.join(refs)}]::text[]) r(value)
    WHERE strpos(${column}::text, to_json(r.value)::text) > 0)`;
  // Outbox payloads include tenant-owned Alexa values, not just relational FKs.
  await tx.$executeRaw`DELETE FROM "NativeDomainOutbox" WHERE "homeId" = ${input.homeId}::uuid
    AND "id" <> ${input.operationRowId}::uuid AND (${matches(Prisma.sql`"payload"`)} OR "aggregateId" = ANY(ARRAY[${Prisma.join(refs)}]::text[]))`;
  await tx.$executeRaw`DELETE FROM "IdempotencyRecord" WHERE "homeId" = ${input.homeId}::uuid AND ${matches(Prisma.sql`"responseBody"`)}`;
  const documents = await tx.homeDocument.findMany({ where: { homeId: input.homeId } });
  for (const row of documents) {
    const next = pruneDeletedReferences(row.document, references) ?? {};
    if (JSON.stringify(next) !== JSON.stringify(row.document)) await tx.homeDocument.update({ where: { id: row.id },
      data: { document: next as Prisma.InputJsonValue, revision: { increment: 1 } } });
  }
  const preferences = await tx.memberPreferenceDocument.findMany({ where: { membership: { homeId: input.homeId } } });
  for (const row of preferences) {
    const next = pruneDeletedReferences(row.document, references) ?? {};
    if (JSON.stringify(next) !== JSON.stringify(row.document)) await tx.memberPreferenceDocument.update({ where: { id: row.id },
      data: { document: next as Prisma.InputJsonValue, revision: { increment: 1 } } });
  }
  const tickets = await tx.supportTicket.findMany({ where: { homeId: input.homeId,
    OR: [{ areaId: input.areaId }, { deviceId: { in: input.deviceIds } }] }, select: { id: true } });
  const ticketIds = tickets.map(row => row.id);
  if (ticketIds.length) {
    await tx.supportAccessNotification.deleteMany({ where: { homeId: input.homeId, ticketId: { in: ticketIds } } });
    await tx.nativeSupportTicketTimeline.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await tx.supportSession.updateMany({ where: { homeId: input.homeId, ticketId: { in: ticketIds } }, data: { status: 'REVOKED', desiredRevokedAt: new Date(), areaIds: [] } });
    await tx.supportAccessRequest.updateMany({ where: { homeId: input.homeId, ticketId: { in: ticketIds } }, data: {
      status: 'REVOKED', desiredRevokedAt: new Date(), canonicalAreaIds: [], targetIds: [],
      codeHash: null, employeeHandoffEnvelope: null, employeeProofPublicKey: null } });
    await tx.supportTicket.updateMany({ where: { id: { in: ticketIds }, homeId: input.homeId }, data: {
      areaId: null, deviceId: null, safeDiagnostics: Prisma.JsonNull, description: 'Area deleted', title: null, customerResolution: null } });
  }
  await tx.nativeNotificationDeliveryReceipt.deleteMany({ where: { homeId: input.homeId, destinationDeviceId: { in: input.deviceIds } } });
  await tx.auditEvent.updateMany({ where: { homeId: input.homeId, targetId: { in: [input.areaId, ...input.deviceIds] } },
    data: { metadata: Prisma.JsonNull, targetId: null } });
}
