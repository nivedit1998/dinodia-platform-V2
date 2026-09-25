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
    if (!reason) throw new Stage1AuthError(400, 'resolver_replacement_reason_required', 'A replacement reason is required');
    const now = new Date();
    const replacement = await prisma.$transaction(async (tx) => {
      const hub = await tx.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: { id: true, homeId: true, permanentResolverGeneration: true, permanentResolverStatus: true } });
      if (!hub || hub.permanentResolverStatus !== 'ACTIVE') throw new Stage1AuthError(404, 'resolver_not_available', 'The hub resolver is not available');
      const claim = await tx.homeClaimReference.findFirst({ where: { hubInstallationId: hub.id, state: { in: ['AVAILABLE', 'RESERVED'] } }, orderBy: { generation: 'desc' }, select: { id: true, generation: true, resolverGeneration: true } });
      if (!claim) throw new Stage1AuthError(409, 'resolver_claim_missing', 'The hub has no replaceable current claim');
      const reference = `DNO-HOME-${randomSecret(32)}`;
      const nextGeneration = Math.max(hub.permanentResolverGeneration, claim.resolverGeneration) + 1;
      await tx.homeClaimChallenge.updateMany({ where: { claimReferenceId: claim.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await tx.homeClaimReference.update({ where: { id: claim.id }, data: { resolverGeneration: nextGeneration, companyQrReferenceHash: hashClaimReference(reference), replacedAt: now, updatedAt: now } });
      await tx.hubInstallation.update({ where: { id: hub.id }, data: { permanentResolverHash: hashClaimReference(reference), permanentResolverGeneration: nextGeneration, resolverReplacedAt: now, updatedAt: now } });
      await tx.auditEvent.create({ data: { homeId: hub.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'permanent_hub_label_replaced', targetType: 'HubInstallation', targetId: hub.id, metadata: { reason, previousGeneration: hub.permanentResolverGeneration, nextGeneration, outcome: 'replaced' }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { reference, generation: nextGeneration, replacedAt: now };
    }, { isolationLevel: 'Serializable' });
    return NextResponse.json({ ok: true, ...replacement }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
