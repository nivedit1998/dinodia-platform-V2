// Architecture: Stage 1 bounded operator-session launch. This creates only a
// short-lived workflow handoff; it never reveals the hub machine credential.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyOsSessionLauncher } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { getJwtClaimsFromRequest } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { issueDurableOperatorHandoff } from '@/lib/operatorSessionHandoffStore';
import { requireApprovedOsWorkflow } from '@/lib/osWorkflowAuthorization';

function parseHomeId(raw: string | undefined) { const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : null; }

export async function POST(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const operator = await requireCompanyOsSessionLauncher(req);
  if (operator instanceof NextResponse) return operator;
  const homeId = parseHomeId((await context.params).homeId);
  if (!homeId) return apiBadRequest('Invalid home id.');
  const claims = await getJwtClaimsFromRequest(req);
  const recentAuthAt = Number(claims?.recentAuthAt || 0);
  if (!claims || claims.id !== operator.userId || !Number.isFinite(recentAuthAt) || Date.now() - recentAuthAt > 5 * 60_000 || recentAuthAt > Date.now() + 5_000) return apiFailFromStatus(401, 'Recent reauthentication is required.');
  const body = await req.json().catch(() => ({}));
  const workflow = typeof body.workflow === 'string' ? body.workflow.trim() : '';
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  if (!['INSTALLATION', 'SUPPORT', 'PROPERTY_CORRECTION'].includes(workflow) || !workflowId) return apiBadRequest('An approved OS workflow and reference are required.');
  if (!(await checkRateLimit(`os-access-launch:${operator.userId}:${homeId}`, { maxRequests: 5, windowMs: 15 * 60_000 }))) return apiFailFromStatus(429, 'Too many OS session launches. Please wait and try again.');
  const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true, serial: true } });
  if (!hub) return apiFailFromStatus(404, 'No Dinodia OS hub is linked to this home.');
  const authorised = await requireApprovedOsWorkflow(prisma, { workflow, workflowId, homeId, hubInstallId: hub.id, operatorId: operator.userId, role: operator.role });
  if (!authorised.ok) return apiFailFromStatus(403, 'The selected OS workflow is not approved for this operator and home.');
  const issued = await issueDurableOperatorHandoff({ employeeId: operator.userId, homeId, hubInstallId: hub.id, workflow, workflowId });
  const handoff = issued.value;
  const handoffExpiresAt = issued.expiresAt.toISOString();
  await prisma.auditEvent.create({ data: { homeId, actorUserId: operator.userId, type: 'OS_OPERATOR_SESSION_LAUNCHED', metadata: { hubInstallId: hub.id, workflow, workflowId, handoffExpiresAt, outcome: 'issued' } } });
  const scope = authorised.scope === 'support' ? ['os:support'] : ['os:admin'];
  return NextResponse.json({ ok: true, handoff, handoffExpiresAt, homeId, hubInstallId: hub.id, serial: hub.serial, scope, employeeId: operator.userId }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' } });
}
