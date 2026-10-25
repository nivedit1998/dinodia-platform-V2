import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';
import { validateSupportTicketCreateReceipt, validateSupportTicketCreateRequest } from '@/lib/contracts/dinodiaV1';
import { createNativeSupportTicket } from '@/lib/nativeSupportTickets';
import type { NativeSupportCategory } from '@prisma/client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const url = new URL(request.url);
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 30 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || [...url.searchParams.keys()].some((key) => key !== 'limit')) {
      throw new Stage1AuthError(400, 'support_ticket_query_invalid', 'The support-ticket query is invalid');
    }
    const tickets = await prisma.supportTicket.findMany({
      where: { customerAccountId: customer.id, homeId: customer.homeId, selectedMembershipId: customer.membershipId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit,
      select: {
        id: true, publicReference: true, customerAccountId: true, homeId: true, selectedMembershipId: true,
        nativeCategory: true, status: true, revision: true, createdAt: true, updatedAt: true, closedAt: true,
      },
    });
    return NextResponse.json({ ok: true, tickets: tickets.map((ticket) => ({
      ticketId: ticket.id, publicReference: ticket.publicReference, customerAccountId: ticket.customerAccountId,
      homeId: ticket.homeId, homeMembershipId: ticket.selectedMembershipId, category: ticket.nativeCategory,
      status: ticket.status, revision: ticket.revision, createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(), closedAt: ticket.closedAt?.toISOString() ?? null,
    })) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !validateSupportTicketCreateRequest(body)) throw new Stage1AuthError(400, 'support_ticket_fields_invalid', 'A supported category and description are required');
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
    if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) throw new Stage1AuthError(400, 'idempotency_key_invalid', 'A valid support request idempotency key is required');
    const category = String(body.category);
    const description = String(body.description).trim();
    const namespace = 'customer-support-ticket:v1';
    const keyHash = sha256(`${customer.id}:${idempotencyKey}`);
    const requestHash = sha256(JSON.stringify({ accountId: customer.id, homeId: customer.homeId,
      membershipId: customer.membershipId, category, description }));
    let result: { receipt: { ok: true; ticket: { id: string; publicReference: string; status: string; createdAt: string } }; replayed: boolean } | undefined;
    for (let attempt = 0; attempt < 4 && !result; attempt += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const prior = await tx.idempotencyRecord.findUnique({
            where: { namespace_keyHash: { namespace, keyHash } },
            select: { actorId: true, homeId: true, hubInstallationId: true, requestHash: true,
              responseBody: true, responseStatus: true, expiresAt: true },
          });
          if (prior) {
            if (prior.actorId !== customer.id || prior.homeId !== customer.homeId || prior.hubInstallationId !== null
              || prior.requestHash !== requestHash) throw new Stage1AuthError(409, 'idempotency_key_reused', 'This support request key belongs to a different operation');
            if (prior.expiresAt <= new Date() || !prior.responseBody || typeof prior.responseBody !== 'object' || Array.isArray(prior.responseBody)) {
              throw new Stage1AuthError(409, 'idempotency_result_expired', 'Refresh support requests before creating a new request');
            }
            const receipt = prior.responseBody as { ok: true; ticket: { id: string; publicReference: string; status: string; createdAt: string } };
            if (!validateSupportTicketCreateReceipt(receipt)) throw new Stage1AuthError(409, 'idempotency_result_invalid', 'Refresh support requests before retrying');
            return { receipt, replayed: true };
          }
          const idempotency = await tx.idempotencyRecord.create({ data: {
            namespace, keyHash, actorId: customer.id, homeId: customer.homeId,
            requestHash, responseStatus: 201, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }, select: { id: true } });
          const ticket = await createNativeSupportTicket(tx, {
            publicReference: `DNO-${randomSecret(9).toUpperCase()}`.slice(0, 20),
            customerAccountId: customer.id, homeId: customer.homeId,
            membershipId: customer.membershipId, category: category as NativeSupportCategory, description,
          });
          const receipt = { ok: true as const, ticket: { id: ticket.id, publicReference: ticket.publicReference,
            status: ticket.status, createdAt: ticket.createdAt.toISOString() } };
          if (!validateSupportTicketCreateReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support-ticket response failed contract validation');
          await tx.idempotencyRecord.update({ where: { id: idempotency.id }, data: {
            responseDigest: sha256(JSON.stringify(receipt)), responseBody: receipt,
          } });
          return { receipt, replayed: false };
        }, { isolationLevel: 'Serializable' });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if ((code === 'P2002' || code === 'P2034') && attempt < 3) continue;
        throw error;
      }
    }
    if (!result) throw new Stage1AuthError(503, 'support_request_retry_exhausted', 'Refresh support requests before retrying');
    return NextResponse.json(result.receipt, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Idempotent-Replay': String(result.replayed) } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
