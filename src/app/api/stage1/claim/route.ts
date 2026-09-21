import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getCurrentUserFromRequest, getJwtClaimsFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCompanyProvisionOperator } from '@/lib/companyPortalGuards';
import { authenticateProvisioningHubRequest } from '@/lib/provisioningHubAuth';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { claimStage1Reservation, persistStage1SetupMutation, releaseStage1Reservation, reserveStage1Claim, resolveStage1Claim } from '@/lib/stage1ClaimReservation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore() {
  return { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };
}

async function bodyOf(req: NextRequest) {
  return await req.json().catch(() => null) as Record<string, unknown> | null;
}

async function requireVerifiedAccount(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) return { response: apiFailFromStatus(401, 'A signed-in account is required.') } as const;
  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, emailVerifiedAt: true, isActive: true } });
  if (!account?.isActive || !account.emailVerifiedAt) return { response: apiFailFromStatus(403, 'Verify your email before claiming this home.') } as const;
  return { account } as const;
}

async function authenticateHub(body: Record<string, unknown>, req: NextRequest) {
  const result = await authenticateProvisioningHubRequest(body, req, '/api/stage1/claim');
  if ('error' in result) return result.error;
  return result;
}

export async function POST(req: NextRequest) {
  const body = await bodyOf(req);
  if (!body) return apiBadRequest('Invalid request body.');
  const action = typeof body.action === 'string' ? body.action : '';
  const reference = typeof body.homeQrReference === 'string' ? body.homeQrReference.trim() : '';
  const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
  if (!action) return apiBadRequest('A Stage 1 claim action is required.');

  if (action === 'release') {
    const operator = await requireCompanyProvisionOperator(req);
    if (operator instanceof NextResponse) return operator;
    const claims = await getJwtClaimsFromRequest(req);
    const recentAuth = claims?.id === operator.userId && typeof claims.recentAuthAt === 'number' && Date.now() - claims.recentAuthAt <= 5 * 60_000;
    if (!recentAuth) return apiFailFromStatus(403, 'Recent authentication is required for manual reservation release.');
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!reference) return apiBadRequest('The Home QR reference is required.');
    const released = await releaseStage1Reservation({ homeQrReference: reference, reason, actorUserId: operator.userId });
    if (!released.ok) return apiFailFromStatus(409, 'This reservation is no longer releasable.');
    return NextResponse.json({ ok: true, state: 'AVAILABLE' }, { headers: noStore() });
  }

  if (!reference || !serial) return apiBadRequest('The hub serial and Home QR reference are required.');
  const hub = await authenticateHub(body, req);
  if (hub instanceof NextResponse) return hub;
  if (!hub) return apiFailFromStatus(401, 'A valid hub proof is required.');
  if (hub.serial !== serial) return apiFailFromStatus(403, 'The hub proof does not match this Home QR.');

  if (action === 'resolve') {
    const resolved = await resolveStage1Claim({ homeQrReference: reference, serial });
    if (!resolved.ok) return apiFailFromStatus(404, 'This Home QR is not available.');
    return NextResponse.json(resolved, { headers: noStore() });
  }

  const accountResult = await requireVerifiedAccount(req);
  if ('response' in accountResult) return accountResult.response;

  if (action === 'reserve') {
    const reserved = await reserveStage1Claim({ homeQrReference: reference, serial, accountId: accountResult.account.id });
    if (!reserved.ok) return apiFailFromStatus(409, 'This home is currently being claimed. Please try again later.');
    return NextResponse.json({ ok: true, reservationToken: reserved.reservationToken, expiresAt: reserved.expiresAt.toISOString(), stage3ActivationRequired: true }, { headers: noStore() });
  }

  const reservationToken = typeof body.reservationToken === 'string' ? body.reservationToken : '';
  if (!reservationToken || reservationToken.length < 32 || reservationToken.length > 128) return apiBadRequest('A valid reservation is required.');
  if (action === 'setup_mutation') {
    const mutation = typeof body.mutation === 'string' ? body.mutation : '';
    const rawCheckpoint = body.checkpoint && typeof body.checkpoint === 'object' ? body.checkpoint : {};
    const checkpoint = JSON.parse(JSON.stringify(rawCheckpoint)) as Prisma.InputJsonValue;
    const saved = await persistStage1SetupMutation({ reservationToken, accountId: accountResult.account.id, mutation, checkpoint });
    if (!saved.ok) return apiFailFromStatus(409, 'The claim reservation is no longer active.');
    return NextResponse.json({ ok: true, expiresAt: saved.expiresAt.toISOString() }, { headers: noStore() });
  }
  if (action === 'claim') {
    const claimed = await claimStage1Reservation({ reservationToken, accountId: accountResult.account.id });
    if (!claimed.ok) return apiFailFromStatus(409, 'The claim reservation is no longer active.');
    return NextResponse.json(claimed, { headers: noStore() });
  }
  return apiBadRequest('Unsupported Stage 1 claim action.');
}
