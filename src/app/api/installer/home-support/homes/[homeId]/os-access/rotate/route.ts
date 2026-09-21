// Architecture: Stage 1 operator credential rotation. Only CXO and Senior
// Operations Manager may execute this; delivery remains hub-bound.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyOsCredentialRotator } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { createPendingOperatorCredential } from '@/lib/hubOperatorCredentials';
import { checkRateLimit } from '@/lib/rateLimit';
import { getJwtClaimsFromRequest } from '@/lib/auth';

function parseHomeId(raw: string | undefined) { const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : null; }

export async function POST(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const operator = await requireCompanyOsCredentialRotator(req);
  if (operator instanceof NextResponse) return operator;
  const homeId = parseHomeId((await context.params).homeId);
  if (!homeId) return apiBadRequest('Invalid home id.');
  const claims = await getJwtClaimsFromRequest(req);
  if (!claims || claims.id !== operator.userId || !claims.recentAuthAt || Date.now() - Number(claims.recentAuthAt) > 5 * 60_000) return apiFailFromStatus(401, 'Recent reauthentication is required.');
  if (!(await checkRateLimit(`os-access-rotate:${operator.userId}:${homeId}`, { maxRequests: 5, windowMs: 60 * 60_000 }))) return apiFailFromStatus(429, 'Too many credential rotations. Please wait and try again.');
  const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true, publishedOperatorCredentialVersion: true } });
  if (!hub) return apiFailFromStatus(404, 'No Dinodia OS hub is linked to this home.');
  const result = await createPendingOperatorCredential(hub.id, hub.publishedOperatorCredentialVersion + 1);
  await prisma.auditEvent.create({ data: { homeId, actorUserId: operator.userId, type: 'OS_OPERATOR_CREDENTIAL_ROTATION_REQUESTED', metadata: { hubInstallId: hub.id, version: result.record.version, outcome: 'pending_hub_acknowledgement' } } });
  return NextResponse.json({ ok: true, credential: result.record, delivery: { state: 'hub_acknowledgement_required' }, requestedBy: operator.userId }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
