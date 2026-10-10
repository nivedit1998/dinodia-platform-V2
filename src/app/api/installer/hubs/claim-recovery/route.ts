import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

/**
 * Read-only eligibility preview for issuing a replacement initial-owner QR.
 * It intentionally returns no Home/account details and never returns a claim
 * reference. The actual generation change remains a separate confirmed POST.
 */
export async function GET(request: Request) {
  try {
    await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const serialNumber = new URL(request.url).searchParams.get('serialNumber')?.trim() ?? '';
    if (!serialNumber || serialNumber.length > 120) throw new Stage1AuthError(400, 'serial_number_invalid', 'Enter the serial printed on the existing hub');

    const hub = await prisma.hubInstallation.findUnique({
      where: { serialNumberSnapshot: serialNumber },
      select: {
        id: true, homeId: true, state: true, lifecycleStatus: true, permanentResolverGeneration: true,
        permanentResolverStatus: true,
        manufacturingIdentity: { select: { status: true } },
        home: { select: { activeHubInstallationId: true } },
      },
    });
    if (!hub || hub.state !== 'ACTIVE' || hub.lifecycleStatus !== 'ACTIVE' || hub.permanentResolverStatus !== 'ACTIVE'
      || hub.manufacturingIdentity.status !== 'ACTIVE' || hub.home.activeHubInstallationId !== hub.id) {
      throw new Stage1AuthError(404, 'claim_recovery_unavailable', 'No eligible active Home claim was found for that hub');
    }

    const claims = await prisma.homeClaimReference.findMany({
      where: { hubInstallationId: hub.id, purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: hub.permanentResolverGeneration, cancelledAt: null, revokedAt: null, invalidatedAt: null },
      orderBy: { generation: 'desc' }, take: 2,
      select: { id: true, generation: true, resolverGeneration: true, claimedAccountId: true },
    });
    const claim = claims.length === 1 ? claims[0] : null;
    const now = new Date();
    const [activeReservations, activeOwners] = claim ? await Promise.all([
      prisma.homeClaimReservation.count({ where: { claimReferenceId: claim.id, state: 'ACTIVE', expiresAt: { gt: now } } }),
      prisma.homeMembership.count({ where: { homeId: hub.homeId, role: 'OWNER', status: 'ACTIVE' } }),
    ]) : [0, 0];
    const eligible = Boolean(claim && claim.claimedAccountId === null
      && claim.resolverGeneration === hub.permanentResolverGeneration
      && activeReservations === 0 && activeOwners === 0);

    return NextResponse.json({
      ok: true,
      eligible,
      reasonCode: eligible ? null : claims.length > 1 ? 'multiple_current_claims'
        : !claim ? 'initial_owner_claim_unavailable'
        : claim.resolverGeneration !== hub.permanentResolverGeneration ? 'resolver_generation_mismatch'
          : activeReservations > 0 ? 'claim_in_progress'
          : activeOwners > 0 || claim.claimedAccountId !== null ? 'home_already_claimed' : 'claim_unavailable',
      hubInstallationId: eligible ? hub.id : null,
      claimGeneration: claim?.generation ?? null,
      resolverGeneration: claim?.resolverGeneration ?? null,
    }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
