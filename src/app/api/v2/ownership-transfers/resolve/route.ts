import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateOwnershipTransferResolveReceipt, validateOwnershipTransferResolveRequest } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { redeemOwnershipTransfer } from '@/lib/ownershipTransfer';
import { homeownerLifecycleMutationsEnabled, LIFECYCLE_REHEARSAL_REQUIRED } from '@/lib/homeownerLifecycleAvailability';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    if (!homeownerLifecycleMutationsEnabled()) throw new Stage1AuthError(503, LIFECYCLE_REHEARSAL_REQUIRED, 'Ownership transfer is unavailable until its safety rehearsal is approved');
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateOwnershipTransferResolveRequest(body)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A valid transfer QR or emailed code is required');
    }
    const tokenHash = customer.credentialKind === 'access' ? customer.accessTokenHash : customer.refreshTokenHash;
    if (!tokenHash) throw new Stage1AuthError(401, 'customer_session_invalid', 'A current customer session is required');
    const result = await redeemOwnershipTransfer({ principal: { id: customer.id, sessionId: customer.sessionId,
      trustedDeviceId: customer.trustedDeviceId, tokenHash, credentialKind: customer.credentialKind,
      securityVersion: customer.securityVersion, trustedDeviceSessionVersion: customer.trustedDeviceSessionVersion },
      reference: body.reference, idempotencyKey: body.idempotencyKey,
      ...(body.resolverProof === undefined ? {} : { resolverProof: body.resolverProof as unknown as Record<string, unknown> }) });
    const receipt = { schemaVersion: 'dinodia.v1' as const, ok: true as const, ...result };
    if (!validateOwnershipTransferResolveReceipt(receipt)) throw new Stage1AuthError(503, 'CONTRACT_RECEIPT_INVALID', 'The transfer receipt is unavailable');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
