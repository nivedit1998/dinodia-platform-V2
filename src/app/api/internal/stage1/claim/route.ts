import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { activatePendingInitialClaim, completeClaimSetup, correctRetainedAddressContract, readClaimAddressContract, recordQualifyingClaimMutation, redeemClaimContract, releaseExpiredClaim } from '@/lib/stage1ClaimContract';
import { constantTimeEqual } from '@/lib/stage1Crypto';
import { consumeSignedClaimResolverProof } from '@/lib/stage1ClaimResolver';
import { serializableTransaction } from '@/lib/serializableTransaction';

export const dynamic = 'force-dynamic';

function gate(request: Request) {
  if (String(process.env.V2_ENVIRONMENT ?? '') === 'production') throw new Stage1AuthError(404, 'stage1_contract_not_public', 'The Stage 1 contract harness is not a public customer route');
  const expected = String(process.env.STAGE1_CONTRACT_SECRET ?? '');
  if (!expected || !constantTimeEqual(request.headers.get('x-stage1-contract-secret') ?? '', expected)) throw new Stage1AuthError(401, 'stage1_contract_unauthorized', 'The contract harness is restricted');
}

async function consumeResolverProof(body: Record<string, unknown>) {
  return serializableTransaction(async (tx) => {
    const result = await consumeSignedClaimResolverProof(tx, body);
    return { challengeId: result.challengeId, homeId: result.homeId,
      resolverGeneration: result.resolverGeneration, consumedAt: result.consumedAt };
  });
}

export async function POST(request: Request) {
  try {
    gate(request);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? '').trim();
    if (action === 'resolve') return NextResponse.json({ ok: true, ...(await consumeResolverProof(body)) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'redeem') {
      const accountId = String(body.customerAccountId ?? '');
      const account = await prisma.customerAccount.findUnique({ where: { id: accountId }, select: { id: true, emailVerifiedAt: true } });
      if (!account) throw new Stage1AuthError(404, 'contract_account_missing', 'The contract account does not exist');
      return NextResponse.json({ ok: true, ...(await redeemClaimContract({ reference: String(body.reference ?? ''), customerAccountId: account.id, emailVerified: Boolean(account.emailVerifiedAt),
        ...(body.resolverProof && typeof body.resolverProof === 'object' && !Array.isArray(body.resolverProof) ? { resolverProof: body.resolverProof as Record<string, unknown> } : {}) })) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'mutate') return NextResponse.json({ ok: true, ...(await recordQualifyingClaimMutation(String(body.reservationId ?? ''), String(body.customerAccountId ?? ''), String(body.step ?? ''), body.mutation && typeof body.mutation === 'object' ? body.mutation as Record<string, unknown> : {})) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'address') return NextResponse.json({ ok: true, ...(await readClaimAddressContract(String(body.reservationId ?? ''), String(body.customerAccountId ?? ''))) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'correct_address') return NextResponse.json({ ok: true, ...(await correctRetainedAddressContract(String(body.homeId ?? ''), String(body.employeeId ?? ''), body.address && typeof body.address === 'object' ? body.address as Record<string, unknown> : {})) }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'get_help') return NextResponse.json({ ok: true, authorityChanged: false, next: 'SUPPORT' }, { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'complete') return NextResponse.json(await completeClaimSetup(String(body.reservationId ?? ''), String(body.customerAccountId ?? '')), { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'activate') return NextResponse.json(await activatePendingInitialClaim(String(body.reservationId ?? ''), String(body.customerAccountId ?? '')), { headers: { 'Cache-Control': 'no-store' } });
    if (action === 'release') {
      const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
      return NextResponse.json({ ok: true, ...(await releaseExpiredClaim(String(body.reservationId ?? ''), { employeeId: employee.id, reason: String(body.reason ?? '').trim().slice(0, 500) })) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    throw new Stage1AuthError(400, 'contract_action_invalid', 'The contract action is invalid');
  } catch (error) { return authErrorResponse(error); }
}
