import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Stage1AuthError, requireCustomerAccountSession } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';

export const dynamic = 'force-dynamic';

/** Account-global inventory: it never requires or selects a Home. */
export async function GET(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request);
    const devices = await prisma.trustedDevice.findMany({
      where: { customerAccountId: account.id },
      orderBy: [{ revokedAt: 'asc' }, { lastUsedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, deviceName: true, model: true, osFamily: true, osVersion: true,
        firstSeenAt: true, lastUsedAt: true, revokedAt: true,
      },
    });
    if (!devices.some((device) => device.id === account.trustedDeviceId)) {
      throw new Stage1AuthError(401, 'customer_session_invalid', 'The current trusted installation is no longer active');
    }
    const deviceIds = devices.map((device) => device.id);
    const [activeMemberships, authorisations, activeSessions] = await Promise.all([
      prisma.homeMembership.findMany({ where: { customerAccountId: account.id, status: 'ACTIVE' }, select: { id: true, homeId: true, role: true, home: { select: { postcode: true } } } }),
      prisma.offlineMembershipAuthorisation.findMany({ where: { trustedDeviceId: { in: deviceIds } }, orderBy: [{ homeId: 'asc' }, { updatedAt: 'desc' }], select: { id: true, trustedDeviceId: true, membershipId: true, homeId: true, policyRevision: true, issuedAt: true, revokedAt: true } }),
      prisma.customerSession.findMany({ where: { trustedDeviceId: { in: deviceIds }, revokedAt: null, expiresAt: { gt: new Date() }, absoluteExpiresAt: { gt: new Date() } }, select: { trustedDeviceId: true } }),
    ]);
    const activeHomeIds = new Set(activeMemberships.map((membership) => membership.homeId));
    const activeTenantMembershipIds = new Set(activeMemberships.filter((membership) => membership.role === 'TENANT').map((membership) => membership.id));
    const homePostcodes = new Map(activeMemberships.map((membership) => [membership.homeId, membership.home.postcode]));
    const now = new Date();
    const result = devices.map((device) => ({
      trustedDeviceId: device.id,
      deviceName: device.deviceName,
      model: device.model,
      osFamily: device.osFamily,
      osVersion: device.osVersion,
      firstSeenAt: device.firstSeenAt.toISOString(),
      lastUsedAt: device.lastUsedAt.toISOString(),
      thisDevice: device.id === account.trustedDeviceId,
      state: device.revokedAt ? 'REVOKED' : 'ACTIVE',
      activeSessionCount: activeSessions.filter((session) => session.trustedDeviceId === device.id).length,
      offlineEnrolments: authorisations.filter((grant) => grant.trustedDeviceId === device.id).map((grant) => ({
        homePostcode: activeHomeIds.has(grant.homeId) ? homePostcodes.get(grant.homeId) : null,
        state: grant.revokedAt ? 'CLOUD_REVOKED_ENFORCEMENT_UNCONFIRMED' : activeTenantMembershipIds.has(grant.membershipId) && !device.revokedAt ? 'ACTIVE' : 'REVIEW_REQUIRED',
        policyRevision: grant.policyRevision,
        updatedAt: grant.revokedAt?.toISOString() ?? grant.issuedAt.toISOString(),
      })),
    }));
    return NextResponse.json({ schemaVersion: 'dinodia.v1', devices: result, asOf: now.toISOString() }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
