import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, requireEmployee } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER', 'SENIOR_CUSTOMER_SUPPORT']);
    const tickets = await prisma.supportTicket.findMany({
      where: { assignedEmployeeId: employee.id, status: 'OPEN' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { id: true, publicReference: true, category: true, status: true, homeId: true, description: true },
    });
    const accessRequests = await prisma.supportAccessRequest.findMany({ where: { ticketId: { in: tickets.map((ticket) => ticket.id) } }, orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, ticketId: true, status: true, requestedScope: true, createdAt: true } });
    const requestsByTicket = new Map<string, typeof accessRequests>();
    for (const requestRow of accessRequests) requestsByTicket.set(requestRow.ticketId, [...(requestsByTicket.get(requestRow.ticketId) || []), requestRow]);
    return NextResponse.json({ ok: true, tickets: tickets.map((ticket) => ({ ...ticket, accessRequests: requestsByTicket.get(ticket.id) || [] })) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
