import type { Prisma } from '@prisma/client';

export class ExceptionalTransferDenied extends Error {}

/** Creates only a reviewed transfer case; ownership remains with the current membership. */
export async function createExceptionalOwnershipTransfer(db: Prisma.TransactionClient, input: {
  homeId: string; outgoingOwnerMembershipId: string; employeeId: string; encryptedIncomingEmail: string;
  encryptionKeyVersion: number; reason: string; verificationMethod: string; verificationReference: string; staffAttestation: string; now?: Date;
}) {
  const bounded = (value: string, limit: number) => typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= limit;
  if (!bounded(input.encryptedIncomingEmail, 4096) || !Number.isSafeInteger(input.encryptionKeyVersion) || input.encryptionKeyVersion < 1 || !bounded(input.reason, 1000) || !bounded(input.verificationMethod, 80) || !bounded(input.verificationReference, 200) || !bounded(input.staffAttestation, 1000)) throw new ExceptionalTransferDenied('Complete bounded case fields are required');
  const [employee, owner] = await Promise.all([
    db.companyEmployeeAccount.findFirst({ where: { id: input.employeeId, status: 'ACTIVE', role: { in: ['CXO', 'SENIOR_OPERATIONS_MANAGER'] } }, select: { id: true } }),
    db.homeMembership.findFirst({ where: { id: input.outgoingOwnerMembershipId, homeId: input.homeId, role: 'OWNER', status: 'ACTIVE' }, select: { id: true } }),
  ]);
  if (!employee || !owner) throw new ExceptionalTransferDenied('Authorised employee and current owner are required');
  const existing = await db.exceptionalOwnershipTransfer.findFirst({ where: { homeId: input.homeId, status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } }, select: { id: true } });
  if (existing) throw new ExceptionalTransferDenied('An exceptional transfer case is already open');
  const now = input.now ?? new Date();
  const created = await db.exceptionalOwnershipTransfer.create({
    data: { homeId: input.homeId, outgoingOwnerMembershipId: owner.id, createdByEmployeeId: employee.id, proposedIncomingEmailCiphertext: input.encryptedIncomingEmail, contactKeyVersion: input.encryptionKeyVersion, reason: input.reason.trim(), verificationMethod: input.verificationMethod.trim(), verificationReference: input.verificationReference.trim(), staffAttestation: input.staffAttestation.trim(), status: 'DRAFT', createdAt: now },
    select: { id: true, homeId: true, outgoingOwnerMembershipId: true, status: true, revision: true, createdAt: true },
  });
  await db.auditEvent.create({ data: { homeId: input.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'exceptional_transfer_case_created', targetType: 'ExceptionalOwnershipTransfer', targetId: created.id, metadata: { outcome: 'case_created', ownershipMutated: false }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  return created;
}
