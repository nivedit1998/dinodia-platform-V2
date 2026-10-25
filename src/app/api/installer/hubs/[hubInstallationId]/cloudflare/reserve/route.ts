import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployeeRecentAuth, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ hubInstallationId: string }> }) {
  try {
    const employee = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER']);
    const { hubInstallationId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const workflowId = String(body.workflowId ?? '').trim();
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    if (!workflowId || !reason) throw new Stage1AuthError(400, 'cloudflare_reservation_invalid', 'Workflow and reason are required');
    const result = await prisma.$transaction(async (tx) => {
      const work = await tx.companyOperationalWorkItem.findUnique({ where: { id: workflowId }, select: { assignedEmployeeId: true, homeId: true, hubInstallationId: true, state: true } });
      if (!work || work.assignedEmployeeId !== employee.id || work.hubInstallationId !== hubInstallationId || !work.homeId || !['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(work.state)) throw new Stage1AuthError(403, 'workflow_not_authorized', 'The workflow is not assigned to this hub');
      const hub = await tx.hubInstallation.findUnique({ where: { id: hubInstallationId }, select: { id: true, homeId: true, reservedHostname: true, reservedTunnelName: true, cloudflareTunnelId: true, cloudflareReservationToken: true } });
      if (!hub || hub.homeId !== work.homeId || !hub.reservedHostname || !hub.reservedTunnelName) throw new Stage1AuthError(409, 'cloudflare_reservation_missing', 'The installation has no reserved hostname and tunnel name');
      const reservationToken = hub.cloudflareReservationToken || randomSecret(32);
      if (!hub.cloudflareReservationToken) await tx.hubInstallation.update({ where: { id: hub.id }, data: { cloudflareReservationToken: reservationToken } });
      await tx.auditEvent.create({ data: { homeId: hub.homeId, actorType: 'EMPLOYEE', actorId: employee.id, category: 'SECURITY', action: 'cloudflare_tunnel_reserved', targetType: 'HubInstallation', targetId: hub.id, metadata: { workflowId, tunnelId: hub.cloudflareTunnelId || null, reservedHostname: hub.reservedHostname, reservedTunnelName: hub.reservedTunnelName, reason, outcome: 'reserved-before-creation' }, purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) } });
      // The reservation proof is hub-only material. The installer receives the
      // reservation identity, never the token used by the paired machine.
      return { hubInstallationId: hub.id, reservedHostname: hub.reservedHostname, reservedTunnelName: hub.reservedTunnelName, tunnelId: hub.cloudflareTunnelId };
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
