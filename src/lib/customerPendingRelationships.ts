import { prisma } from './prisma';
import { Stage1AuthError } from './stage1Auth';

/**
 * A bounded, account-global projection over the existing Stage 3 workflow
 * authorities. It intentionally does not return street addresses, areas,
 * devices, other users, floorplans or analytics for unaccepted relationships.
 */
export async function listCustomerPendingRelationships(customerAccountId: string) {
  const now = new Date();
  const account = await prisma.customerAccount.findUnique({ where: { id: customerAccountId }, select: { id: true, emailNormalized: true, status: true, emailVerifiedAt: true } });
  if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(401, 'customer_session_invalid', 'The customer account is no longer active');

  const [invitations, roomRequests, reservations] = await Promise.all([
    prisma.membershipInvitation.findMany({
      where: {
        state: 'PENDING', expiresAt: { gt: now },
        OR: [{ targetAccountId: account.id }, { targetEmailNormalized: account.emailNormalized }],
        home: { lifecycle: 'ACTIVE' },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, role: true, createdAt: true, expiresAt: true, updatedAt: true,
        home: { select: { postcode: true } },
        inviter: { select: { customerAccount: { select: { displayName: true } } } },
      },
      take: 50,
    }),
    prisma.areaAccessRequest.findMany({
      where: { requesterAccountId: account.id, status: 'PENDING', expiresAt: { gt: now }, area: { status: 'ACTIVE', home: { lifecycle: 'ACTIVE' } } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, createdAt: true, updatedAt: true, expiresAt: true, area: { select: { originalName: true, home: { select: { postcode: true } } } } },
      take: 50,
    }),
    prisma.homeClaimReservation.findMany({
      where: {
        customerAccountId: account.id,
        OR: [
          { state: 'ACTIVE', expiresAt: { gt: now }, pendingSetup: { is: { state: { notIn: ['EXPIRED', 'CANCELLED', 'ACTIVATED'] } } } },
          { state: 'CONVERTED_TO_PENDING_INSTALLATION', pendingSetup: { is: { state: 'PENDING_INSTALLATION' } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, state: true, expiresAt: true, setupRevision: true, createdAt: true,
        pendingSetup: { select: { state: true, requiredStep: true, setupRevision: true } },
        claimReference: { select: { home: { select: { postcode: true } } } },
      },
      take: 50,
    }),
  ]);

  const rows = [
    ...invitations.map((row) => ({
      id: row.id, type: 'INVITATION' as const, postcode: row.home.postcode,
      role: row.role, inviterLabel: row.inviter.customerAccount.displayName || 'Dinodia customer',
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      decisionRevision: row.updatedAt.toISOString(),
      state: 'PENDING' as const, allowedActions: ['ACCEPT', 'DECLINE'] as const,
    })),
    ...roomRequests.map((row) => ({
      id: row.id, type: 'ROOM_ACCESS_REQUEST' as const, postcode: row.area.home.postcode,
      areaLabel: row.area.originalName, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      decisionRevision: row.updatedAt.toISOString(),
      state: 'PENDING' as const, allowedActions: ['VIEW_STATUS', 'CANCEL'] as const,
    })),
    ...reservations.map((row) => ({
      id: row.id,
      type: row.state === 'ACTIVE' ? 'HOME_SETUP' as const : 'INSTALLATION_PENDING' as const,
      postcode: row.claimReference.home.postcode,
      createdAt: row.createdAt.toISOString(), expiresAt: row.state === 'ACTIVE' ? row.expiresAt.toISOString() : null,
      state: row.pendingSetup?.state ?? row.state,
      revision: row.pendingSetup?.setupRevision ?? row.setupRevision,
      requiredStep: row.pendingSetup?.requiredStep ?? null,
      allowedActions: row.state === 'ACTIVE' ? ['RESUME_SETUP'] as const : ['VIEW_STATUS', 'REFRESH'] as const,
    })),
  ];

  rows.sort((left, right) => {
    const leftTime = left.expiresAt ? Date.parse(left.expiresAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.expiresAt ? Date.parse(right.expiresAt) : Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
  return { schemaVersion: 'dinodia.v1' as const, asOf: now.toISOString(), pendingRelationships: rows };
}
