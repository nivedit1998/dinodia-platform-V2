import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { assertClaimSessionCurrent } from '@/lib/stage1ClaimContract';
import { validateInvitedTenantUsernameReceipt, validateInvitedTenantUsernameRequest } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request, { allowPolicyGate: true, allowUsernameSetup: true });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateInvitedTenantUsernameRequest(body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose a username using 3–80 letters, numbers, dots, underscores or hyphens');
    }
    const username = body.username;
    const usernameNormalized = username.toLowerCase();
    const receipt = await prisma.$transaction(async (tx) => {
      await assertClaimSessionCurrent(tx, principal);
      const account = await tx.customerAccount.findUnique({ where: { id: principal.id }, select: { usernameSelectionRequired: true, emailVerifiedAt: true } });
      if (!account || !account.emailVerifiedAt || !account.usernameSelectionRequired) throw new Stage1AuthError(409, 'REVISION_CONFLICT', 'This account is not waiting for its invited username');
      const conflict = await tx.customerAccount.findFirst({ where: { usernameNormalized, id: { not: principal.id } }, select: { id: true } });
      if (conflict) throw new Stage1AuthError(409, 'customer_username_unavailable', 'Choose a different username');
      const now = new Date();
      const updated = await tx.customerAccount.update({ where: { id: principal.id }, data: {
        username, usernameNormalized, usernameSelectionRequired: false, updatedAt: now,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      }, select: { username: true, usernameNormalized: true } });
      await tx.auditEvent.create({ data: {
        actorType: 'CUSTOMER', actorId: principal.id, category: 'SECURITY', action: 'invited_tenant_username_selected',
        targetType: 'CustomerAccount', targetId: principal.id, metadata: { outcome: 'completed' },
        occurredAt: now, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      } });
      return { schemaVersion: 'dinodia.v1', ok: true, ...updated, nextAction: 'CONTINUE' };
    }, { isolationLevel: 'Serializable' });
    if (!validateInvitedTenantUsernameReceipt(receipt, username)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The username receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
