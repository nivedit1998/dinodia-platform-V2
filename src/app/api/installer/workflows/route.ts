import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, requireEmployee } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

/**
 * Company Portal uses this server-owned list to populate the workflow picker.
 * A browser-supplied workflowId is therefore only a lookup key; it cannot
 * create authority or select work belonging to another employee.
 */
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const url = new URL(request.url);
    const homeId = url.searchParams.get('homeId');
    const work = await prisma.companyOperationalWorkItem.findMany({
      where: {
        assignedEmployeeId: employee.id,
        ...(homeId ? { homeId } : {}),
        state: { in: ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        publicReference: true,
        kind: true,
        state: true,
        homeId: true,
        hubInstallationId: true,
        certifiedSerialNumber: true,
        reason: true,
        notes: true,
        workRevision: true,
        updatedAt: true,
        hubInstallation: { select: { baseUrl: true, cloudUrl: true } },
      },
    });
    return NextResponse.json({ ok: true, workflows: work }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
