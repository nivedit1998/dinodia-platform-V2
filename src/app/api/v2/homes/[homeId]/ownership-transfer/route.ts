import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { validateOwnershipTransferCancelRequest, validateOwnershipTransferCancelReceipt, validateOwnershipTransferStartReceipt, validateOwnershipTransferStartRequest, validateOwnershipTransferStatus } from '@/lib/contracts/dinodiaV1';
import { cancelOwnershipTransfer, currentOwnershipTransfer, startOwnershipTransfer, type TransferPrincipal } from '@/lib/ownershipTransfer';

export const dynamic = 'force-dynamic';
const noStore = { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } };

function selectedPrincipal(account: Awaited<ReturnType<typeof requireCustomerAccountSession>>, selected: Awaited<ReturnType<typeof requireCustomerSelectedHome>>): TransferPrincipal {
  if (selected.id !== account.id || selected.role !== 'OWNER') throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Ownership transfer is available only to the current homeowner');
  const tokenHash = account.credentialKind === 'access' ? account.accessTokenHash : account.refreshTokenHash;
  if (!tokenHash) throw new Stage1AuthError(401, 'customer_session_invalid', 'A current customer session is required');
  return { id: account.id, homeId: selected.homeId, membershipId: selected.membershipId, hubInstallationId: selected.hubInstallationId,
    trustedDeviceId: account.trustedDeviceId, sessionId: account.sessionId, tokenHash,
    credentialKind: account.credentialKind === 'access' ? 'account_access' : 'account_refresh',
    securityVersion: account.securityVersion, trustedDeviceSessionVersion: account.trustedDeviceSessionVersion, policyRevision: selected.policyRevision };
}

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const account = await requireCustomerAccountSession(request);
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (homeId !== selected.homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Ownership transfer is unavailable for this Home');
    const status = await currentOwnershipTransfer({ principal: selectedPrincipal(account, selected), homeId });
    if (!validateOwnershipTransferStatus(status, homeId)) throw new Stage1AuthError(503, 'CONTRACT_PROJECTION_INVALID', 'The current transfer status is unavailable');
    return NextResponse.json(status, noStore);
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const account = await requireCustomerAccountSession(request);
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    if (homeId !== selected.homeId) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Ownership transfer is unavailable for this Home');
    const principal = selectedPrincipal(account, selected);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (validateOwnershipTransferStartRequest(body)) {
      const receipt = { schemaVersion: 'dinodia.v1' as const, ok: true as const, ...await startOwnershipTransfer({ principal, homeId, recipientEmail: body.recipientEmail,
        expectedManagementRevision: body.expectedManagementRevision, proof: body.proof, idempotencyKey: body.idempotencyKey }) };
      if (!validateOwnershipTransferStartReceipt(receipt)) throw new Stage1AuthError(503, 'CONTRACT_RECEIPT_INVALID', 'The transfer receipt is unavailable');
      return NextResponse.json(receipt, { ...noStore, status: 202 });
    }
    if (validateOwnershipTransferCancelRequest(body)) {
      const receipt = await cancelOwnershipTransfer({ principal, homeId, transferId: body.transferId,
        expectedTransferUpdatedAt: body.expectedTransferUpdatedAt, proof: body.proof, idempotencyKey: body.idempotencyKey });
      if (!validateOwnershipTransferCancelReceipt(receipt)) throw new Stage1AuthError(503, 'CONTRACT_RECEIPT_INVALID', 'The cancellation receipt is unavailable');
      return NextResponse.json(receipt, noStore);
    }
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The ownership transfer action is not supported');
  } catch (error) { return nativeV1ErrorResponse(error); }
}
