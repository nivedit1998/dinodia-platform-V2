import { NextResponse } from 'next/server';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { prisma } from '@/lib/prisma';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { randomSecret } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

/**
 * Replaces the permanent physical hub resolver without creating another
 * property claim. The old resolver generation and every outstanding challenge
 * are revoked in the same transaction. The returned reference is intended for
 * the authenticated Company Portal printing flow only.
 */
export async function POST(request: Request, context: { params: Promise<{ hubInstallationId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { hubInstallationId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    const expectedResolverGeneration = Number(body.expectedResolverGeneration);
    if (!reason) throw new Stage1AuthError(400, 'resolver_replacement_reason_required', 'A replacement reason is required');
    if (body.confirmed !== true) throw new Stage1AuthError(400, 'resolver_replacement_confirmation_required', 'Explicit confirmation is required before replacing the current Home QR');
    if (!Number.isSafeInteger(expectedResolverGeneration) || expectedResolverGeneration < 1) throw new Stage1AuthError(400, 'resolver_generation_required', 'Refresh the current Home QR status before replacement');
    const now = new Date();
    const replacement = await prisma.$transaction(async (tx) => {
      const hub = await tx.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: { id: true, homeId: true, state: true, lifecycleStatus: true, permanentResolverGeneration: true, permanentResolverStatus: true, home: { select: { activeHubInstallationId: true } }, manufacturingIdentity: { select: { status: true } } } });
      if (!hub || hub.state !== 'ACTIVE' || hub.lifecycleStatus !== 'ACTIVE' || hub.permanentResolverStatus !== 'ACTIVE'
        || hub.home.activeHubInstallationId !== hub.id || hub.manufacturingIdentity.status !== 'ACTIVE') {
        throw new Stage1AuthError(404, 'resolver_not_available', 'The hub resolver is not available');
      }
      if (hub.permanentResolverGeneration !== expectedResolverGeneration) throw new Stage1AuthError(409, 'resolver_generation_changed', 'The Home QR status changed. Review it again before any replacement');
      const claims = await tx.homeClaimReference.findMany({ where: { hubInstallationId: hub.id, purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: hub.permanentResolverGeneration, cancelledAt: null, revokedAt: null, invalidatedAt: null }, orderBy: { generation: 'desc' }, take: 2, select: { id: true, generation: true, resolverGeneration: true, claimedAccountId: true } });
      const claim = claims.length === 1 ? claims[0] : null;
      if (!claim || claim.claimedAccountId !== null) throw new Stage1AuthError(409, 'resolver_claim_missing', 'There is no single current unclaimed owner QR eligible for replacement');
      const [activeReservations, activeOwners] = await Promise.all([
        tx.homeClaimReservation.count({ where: { claimReferenceId: claim.id, state: 'ACTIVE', expiresAt: { gt: now } } }),
        tx.homeMembership.count({ where: { homeId: hub.homeId, role: 'OWNER', status: 'ACTIVE' } }),
      ]);
      if (activeReservations > 0) throw new Stage1AuthError(409, 'resolver_claim_in_progress', 'A Home claim is already in progress; do not replace its QR');
      if (activeOwners > 0) throw new Stage1AuthError(409, 'resolver_home_already_claimed', 'This Home already has an owner and cannot use initial-owner QR recovery');
      const reference = `DNO-HOME-${randomSecret(32)}`;
      const nextGeneration = Math.max(hub.permanentResolverGeneration, claim.resolverGeneration) + 1;
      await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: claim.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.homeClaimReference.update({ where: { id: claim.id }, data: { resolverGeneration: nextGeneration, companyQrReferenceHash: hashClaimReference(reference), replacedAt: now, updatedAt: now } });
      await tx.hubInstallation.update({ where: { id: hub.id }, data: { permanentResolverHash: hashClaimReference(reference), permanentResolverGeneration: nextGeneration, resolverReplacedAt: now, updatedAt: now } });
      await tx.auditEvent.create({ data: { homeId: hub.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'permanent_hub_label_replaced', targetType: 'HubInstallation', targetId: hub.id, metadata: { reason, previousGeneration: hub.permanentResolverGeneration, nextGeneration, outcome: 'replaced' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { reference, generation: nextGeneration, claimGeneration: claim.generation, replacedAt: now };
    }, { isolationLevel: 'Serializable' });
    return NextResponse.json({ ok: true, ...replacement }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
