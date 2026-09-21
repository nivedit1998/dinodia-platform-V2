// Architecture: Stage 1 emergency operator credential revoke. Plaintext is
// never accepted, returned or logged.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyOsCredentialRevoker } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { revokeOperatorCredentials } from '@/lib/hubOperatorCredentials';
import { checkRateLimit } from '@/lib/rateLimit';
import { getJwtClaimsFromRequest } from '@/lib/auth';

function parseHomeId(raw: string | undefined) { const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : null; }

export async function POST(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const operator = await requireCompanyOsCredentialRevoker(req);
  if (operator instanceof NextResponse) return operator;
  const homeId = parseHomeId((await context.params).homeId);
  if (!homeId) return apiBadRequest('Invalid home id.');
  const claims = await getJwtClaimsFromRequest(req);
  if (!claims || claims.id !== operator.userId || !claims.recentAuthAt || Date.now() - Number(claims.recentAuthAt) > 5 * 60_000) return apiFailFromStatus(401, 'Recent reauthentication is required.');
  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return apiBadRequest('A revocation reason is required.');
  if (!(await checkRateLimit(`os-access-revoke:${operator.userId}:${homeId}`, { maxRequests: 5, windowMs: 60 * 60_000 }))) return apiFailFromStatus(429, 'Too many credential revocations. Please wait and try again.');
  const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true } });
  if (!hub) return apiFailFromStatus(404, 'No Dinodia OS hub is linked to this home.');
  const result = await revokeOperatorCredentials(hub.id, reason);
  await prisma.auditEvent.create({ data: { homeId, actorUserId: operator.userId, type: 'OS_OPERATOR_CREDENTIAL_REVOKED', metadata: { hubInstallId: hub.id, reason: reason.slice(0, 256), revoked: result.revoked, outcome: 'revoked' } } });
  return NextResponse.json({ ok: true, ...result, requestedBy: operator.userId }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
