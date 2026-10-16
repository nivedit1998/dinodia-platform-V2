import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { validateHomeownerTenantAreaGrantsReceipt, validateHomeownerTenantRemovalReceipt } from '@/lib/contracts/dinodiaV1';
import { homeownerRequestHash } from '@/lib/homeownerIdempotency';
import { sha256 } from '@/lib/stage1Crypto';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{16,160}$/;
const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * Read-only reconciliation for a previously submitted homeowner operation.
 * It discloses only the exact actor/Home/target/body receipt protected by the
 * operation's advisory key lock. It never accepts or consumes step-up proof.
 */
export async function POST(request: Request, context: { params: Promise<{ homeId: string; tenantId: string }> }) {
  const startedAt = Date.now();
  let phase = 'authenticate';
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId, tenantId } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!UUID.test(homeId) || !UUID.test(tenantId) || selected.homeId !== homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role) || selected.credentialKind !== 'account_access'
      || !body || !['tenant_area_grants_replace', 'home_tenant_remove'].includes(String(body.operationKind))
      || typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)
      || !Number.isSafeInteger(body.expectedAccessRevision) || Number(body.expectedAccessRevision) < 0
      || !Number.isSafeInteger(body.expectedManagementRevision) || Number(body.expectedManagementRevision) < 1) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This management operation is unavailable for the selected Home');
    }

    const operationKind = body.operationKind as 'tenant_area_grants_replace' | 'home_tenant_remove';
    let namespace: string;
    let requestHash: string;
    if (operationKind === 'home_tenant_remove') {
      if (Object.keys(body).sort().join(',') !== 'expectedAccessRevision,expectedManagementRevision,idempotencyKey,operationKind') {
        throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The saved operation identity is invalid');
      }
      namespace = 'homeowner-tenant-membership-remove:v1';
      requestHash = sha256(JSON.stringify({ homeId, tenantId,
        expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision }));
    } else {
      if (Object.keys(body).sort().join(',') !== 'areaIds,expectedAccessRevision,expectedManagementRevision,idempotencyKey,operationKind'
        || !Array.isArray(body.areaIds) || body.areaIds.length > 64
        || !body.areaIds.every((id) => typeof id === 'string' && UUID.test(id))
        || new Set(body.areaIds).size !== body.areaIds.length) {
        throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The saved Area-access operation identity is invalid');
      }
      namespace = 'homeowner-tenant-area-grants:v1';
      const areaIds = [...body.areaIds as string[]].sort();
      requestHash = homeownerRequestHash({ homeId, membershipId: selected.membershipId, tenantId, areaIds,
        expectedAccessRevision: body.expectedAccessRevision, expectedManagementRevision: body.expectedManagementRevision });
    }

    const keyHash = sha256(`${selected.id}:${body.idempotencyKey}`);
    phase = 'serialize_and_revalidate_authority';
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${keyHash}`}, 0)) IS NULL AS acquired`;
      const now = new Date();
      const [actor, home, hub, account, session, trusted] = await Promise.all([
        tx.homeMembership.findFirst({ where: { id: selected.membershipId, customerAccountId: selected.id, homeId,
          role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, status: 'ACTIVE' }, select: { id: true, accessRevision: true } }),
        tx.home.findFirst({ where: { id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
          select: { id: true, activeHubInstallationId: true } }),
        tx.hubInstallation.findFirst({ where: { id: selected.hubInstallationId, homeId, lifecycleStatus: 'ACTIVE' },
          select: { id: true, accessPolicyRevision: true } }),
        tx.customerAccount.findUnique({ where: { id: selected.id }, select: { id: true, status: true, securityVersion: true } }),
        tx.customerSession.findUnique({ where: { id: selected.sessionId }, select: { id: true, customerAccountId: true,
          trustedDeviceId: true, accessTokenHash: true, accessTokenExpiresAt: true, securityVersion: true,
          trustedDeviceSessionVersion: true, revokedAt: true, expiresAt: true, absoluteExpiresAt: true } }),
        tx.trustedDevice.findUnique({ where: { id: selected.trustedDeviceId }, select: { id: true, customerAccountId: true,
          revokedAt: true, sessionVersion: true } }),
      ]);
      const policy = currentCustomerPolicy();
      const acceptance = policy && await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
        customerAccountId: selected.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version,
      } }, select: { id: true } });
      if (!actor || !home || !hub || home.activeHubInstallationId !== hub.id || !account || account.status !== 'ACTIVE'
        || !session || session.customerAccountId !== account.id || session.trustedDeviceId !== selected.trustedDeviceId
        || session.accessTokenHash !== selected.tokenHash || !session.accessTokenExpiresAt || session.accessTokenExpiresAt <= now
        || session.securityVersion !== account.securityVersion || session.trustedDeviceSessionVersion !== trusted?.sessionVersion
        || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now
        || !trusted || trusted.customerAccountId !== account.id || trusted.revokedAt
        || !policy || !acceptance || Math.max(actor.accessRevision, hub.accessPolicyRevision) !== selected.policyRevision) {
        throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'This management operation is unavailable for the selected Home');
      }

      phase = 'read_exact_saved_receipt';
      const prior = await tx.idempotencyRecord.findUnique({ where: { namespace_keyHash: { namespace, keyHash } },
        select: { actorId: true, homeId: true, requestHash: true, responseBody: true, expiresAt: true } });
      if (!prior) return { status: 'NOT_FOUND' as const };
      if (prior.actorId !== selected.id || prior.homeId !== homeId || prior.requestHash !== requestHash || prior.expiresAt <= now
        || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
        throw new Stage1AuthError(409, 'IDEMPOTENCY_CONFLICT', 'The saved operation key does not match this exact request');
      }
      if (operationKind === 'home_tenant_remove') {
        if (!validateHomeownerTenantRemovalReceipt(prior.responseBody, homeId, tenantId)) {
          throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The saved operation receipt is invalid');
        }
        return { status: 'COMMITTED' as const,
          receipt: { ...prior.responseBody, idempotentReplay: true } };
      }
      if (!validateHomeownerTenantAreaGrantsReceipt(prior.responseBody, homeId, tenantId)) {
        throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The saved operation receipt is invalid');
      }
      return { status: 'COMMITTED' as const, receipt: prior.responseBody };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 1_500, timeout: 20_000 });

    const envelope = result.status === 'NOT_FOUND'
      ? { schemaVersion: 'dinodia.v1', ok: true, status: 'NOT_FOUND', operationKind }
      : { schemaVersion: 'dinodia.v1', ok: true, status: 'COMMITTED', operationKind, receipt: result.receipt };
    return NextResponse.json(envelope, { headers: noStore });
  } catch (error) {
    return nativeV1ErrorResponse(error, { operation: 'homeowner_management_receipt_reconcile', phase, startedAt });
  }
}
