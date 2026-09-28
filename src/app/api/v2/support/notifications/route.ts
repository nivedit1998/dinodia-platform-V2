import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

/** Return only the selected customer's property-scoped notifications. */
export async function GET(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const notifications = await prisma.supportAccessNotification.findMany({
      where: { recipientAccountId: customer.id, homeId: customer.homeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, ticketId: true, eventType: true, createdAt: true },
    });
    return NextResponse.json({ ok: true, notifications }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
