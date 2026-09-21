// Stage 1: return only durable installation workflows assigned to the current
// Company Portal employee. The browser receives a lookup list, never authority.
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyProvisionOperator } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const operator = await requireCompanyProvisionOperator(req);
  if (operator instanceof NextResponse) return operator;
  const now = new Date();
  const workflows = await prisma.osOperatorWorkflow.findMany({
    where: {
      assignedEmployeeId: operator.userId,
      workflowType: 'INSTALLATION',
      status: { in: ['ASSIGNED', 'APPROVED'] },
      approvedAt: { not: null },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, homeId: true, hubInstallId: true, workflowType: true, status: true, approvedAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const hubs = await prisma.hubInstall.findMany({
    where: { id: { in: workflows.map((workflow) => workflow.hubInstallId) } },
    select: { id: true, serial: true, homeId: true },
  });
  const hubById = new Map(hubs.map((hub) => [hub.id, hub]));
  return NextResponse.json({
    ok: true,
    workflows: workflows.flatMap((workflow) => {
      const hub = hubById.get(workflow.hubInstallId);
      if (!hub || hub.homeId !== workflow.homeId) return [];
      return [{ ...workflow, hubSerial: hub.serial }];
    }),
  }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' } });
}
