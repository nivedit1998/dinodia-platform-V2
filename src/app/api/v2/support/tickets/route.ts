import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomer, Stage1AuthError } from '@/lib/stage1Auth';
import { randomSecret } from '@/lib/stage1Crypto';
import { validateSupportTicketCreateReceipt, validateSupportTicketCreateRequest } from '@/lib/contracts/dinodiaV1';
import { createNativeSupportTicket } from '@/lib/nativeSupportTickets';
import type { NativeSupportCategory } from '@prisma/client';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomer(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateSupportTicketCreateRequest(body)) throw new Stage1AuthError(400, 'support_ticket_fields_invalid', 'A supported category and description are required');
    const category = String(body.category);
    const description = String(body.description).trim();
    const publicReference = `DNO-${randomSecret(9).toUpperCase()}`.slice(0, 20);
    const ticket = await prisma.$transaction((tx) => createNativeSupportTicket(tx, {
      publicReference, customerAccountId: customer.id, homeId: customer.homeId,
      membershipId: customer.membershipId, category: category as NativeSupportCategory, description,
    }));
    const receipt = { ok: true, ticket: { id: ticket.id, publicReference: ticket.publicReference, status: ticket.status, createdAt: ticket.createdAt.toISOString() } };
    if (!validateSupportTicketCreateReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support-ticket response failed contract validation');
    return NextResponse.json(receipt, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
