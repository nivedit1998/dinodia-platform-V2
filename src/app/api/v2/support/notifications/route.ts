import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { validateSupportNotificationProjection } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

/** Return only the selected customer's property-scoped notifications. */
export async function GET(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const rows = await prisma.supportAccessNotification.findMany({
      where: { recipientAccountId: customer.id, homeId: customer.homeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, ticketId: true, eventType: true, createdAt: true },
    });
    const notifications = rows.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }));
    const projection = { ok: true, notifications };
    if (!validateSupportNotificationProjection(projection)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support-notification response failed contract validation');
    return NextResponse.json(projection, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
