import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { hashClaimReference } from './stage1ClaimContract';

/**
 * Remove account-wide authority only after the final durable customer
 * relationship is gone. Call inside the membership-removal transaction and
 * after locking the CustomerAccount row, so invitation/claim creators and
 * removers serialize on the same account authority.
 */
export async function cleanupCustomerAccountIfOrphaned(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
  reason: string,
  actionType: string,
): Promise<{ deleted: boolean; anonymousReference: string | null }> {
  let cleanupPhase = 'load_account';
  try {
  const account = await tx.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, emailNormalized: true } });
  if (!account) return { deleted: false, anonymousReference: null };
  const [memberships, invitations, requests, setups, reservations, transfers] = await Promise.all([
    tx.homeMembership.count({ where: { customerAccountId: accountId, status: 'ACTIVE' } }),
    tx.membershipInvitation.count({ where: { state: 'PENDING', expiresAt: { gt: now },
      OR: [{ targetAccountId: accountId }, { targetEmailNormalized: account.emailNormalized }] } }),
    tx.areaAccessRequest.count({ where: { requesterAccountId: accountId, status: 'PENDING', expiresAt: { gt: now } } }),
    tx.pendingHomeSetup.count({ where: { customerAccountId: accountId,
      state: { in: ['PROFILE_REQUIRED', 'ADDRESS_REQUIRED', 'POLICY_REQUIRED', 'PENDING_INSTALLATION', 'READY_TO_ACTIVATE'] },
      expiredAt: null, reservation: { state: 'ACTIVE', expiresAt: { gt: now } } } }),
    tx.homeClaimReservation.count({ where: { customerAccountId: accountId, state: 'ACTIVE', expiresAt: { gt: now } } }),
    tx.homeClaimReference.count({ where: { purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE',
      transferRecipientEmailHash: hashClaimReference(`dinodia-transfer-recipient-v1:${account.emailNormalized}`),
      cancelledAt: null, revokedAt: null, invalidatedAt: null } }),
  ]);
  if (memberships + invitations + requests + setups + reservations + transfers > 0) return { deleted: false, anonymousReference: null };

  const devices = await tx.trustedDevice.findMany({ where: { customerAccountId: accountId }, select: { id: true } });
  const deviceIds = devices.map((device) => device.id);
  await tx.customerSession.updateMany({ where: { customerAccountId: accountId, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason, accessTokenHash: null, accessTokenExpiresAt: null } });
  await tx.trustedDevice.updateMany({ where: { customerAccountId: accountId, revokedAt: null },
    data: { revokedAt: now, sessionVersion: { increment: 1 }, apnsTokenCiphertext: null, apnsTokenDigest: null, pushRevokedAt: now } });
  if (deviceIds.length) await tx.offlineMembershipAuthorisation.updateMany({ where: { trustedDeviceId: { in: deviceIds }, revokedAt: null },
    data: { revokedAt: now, revokeReason: reason } });
  await tx.stepUpChallenge.updateMany({ where: { customerAccountId: accountId, consumedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
  await tx.stepUpAuthorization.updateMany({ where: { customerAccountId: accountId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  await tx.supportTicket.updateMany({ where: { customerAccountId: accountId }, data: {
    status: 'CLOSED', closedAt: now, customerAccountId: null, selectedMembershipId: null,
    description: '[Closed and redacted after relationship removal]', title: null, areaId: null, deviceId: null,
    safeDiagnostics: Prisma.DbNull, customerResolution: null, revision: { increment: 1 },
  } });
  const anonymousReference = `del_${crypto.randomBytes(24).toString('base64url')}`;
  cleanupPhase = 'write_deletion_receipt';
  await tx.deletionSecurityReceipt.create({ data: { anonymousReference, actionType: actionType.slice(0, 120), actionAt: now,
    purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
  // Historical invitations retain a restrictive inviter-membership foreign
  // key even after the inviting relationship was removed. They have no
  // remaining authority or recipient purpose once this account is orphaned;
  // revoke pending generations and erase their recipient/token data before
  // the account cascade removes its historical memberships.
  const removedMemberships = await tx.homeMembership.findMany({ where: { customerAccountId: accountId }, select: { id: true } });
  const removedMembershipIds = removedMemberships.map(({ id }) => id);
  if (removedMembershipIds.length) {
    cleanupPhase = 'purge_exceptional_transfer_cases';
    await tx.exceptionalOwnershipTransfer.deleteMany({ where: { outgoingOwnerMembershipId: { in: removedMembershipIds } } });
    cleanupPhase = 'revoke_membership_invitations';
    await tx.membershipInvitation.updateMany({ where: { inviterMembershipId: { in: removedMembershipIds }, state: 'PENDING' },
      data: { state: 'REVOKED', revokedAt: now } });
    cleanupPhase = 'purge_membership_invitations';
    await tx.membershipInvitation.deleteMany({ where: { inviterMembershipId: { in: removedMembershipIds } } });
    cleanupPhase = 'purge_membership_owned_automations';
    await tx.nativeAutomation.deleteMany({ where: { createdByMembershipId: { in: removedMembershipIds } } });
    cleanupPhase = 'detach_membership_commissioning_history';
    await tx.nativeCommissioningSession.updateMany({ where: { requestingMembershipId: { in: removedMembershipIds } },
      data: { requestingMembershipId: null } });
  }
  cleanupPhase = 'delete_orphaned_customer_account';
  await tx.customerAccount.delete({ where: { id: accountId } });
  return { deleted: true, anonymousReference };
  } catch (error) {
    if (error && typeof error === 'object') Object.defineProperty(error, 'customerCleanupPhase', { value: cleanupPhase, configurable: true });
    throw error;
  }
}
