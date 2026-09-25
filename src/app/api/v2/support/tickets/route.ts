import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomer, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { randomSecret } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json() as Record<string, unknown>;
    const category = String(body.category ?? '').trim().slice(0, 80);
    const description = String(body.description ?? '').trim().slice(0, 4000);
    if (!category || !description) throw new Stage1AuthError(400, 'support_ticket_fields_invalid', 'A support category and description are required');
    const publicReference = `DNO-${randomSecret(9).toUpperCase()}`.slice(0, 20);
    const ticket = await prisma.supportTicket.create({ data: { publicReference, customerAccountId: customer.id, homeId: customer.homeId, selectedMembershipId: customer.membershipId, category, description }, select: { id: true, publicReference: true, status: true, createdAt: true } });
    return NextResponse.json({ ok: true, ticket }, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
