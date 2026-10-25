import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { validateSupportAccessApprovalProjection } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

/** A bounded approval inbox. It intentionally omits ticket text, tenant/device identifiers and staff notes. */
export async function GET(request: Request) {
  try {
    const customer = await requireCustomerSelectedHome(request);
    const rows = await prisma.supportAccessRequest.findMany({
      where: { homeId: customer.homeId, status: 'REQUESTED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
      select: { id: true, ticketId: true, requestedScope: true, targetMembershipId: true, targetUserId: true,
        canonicalAreaIds: true, createdAt: true },
    });
    const tickets = await prisma.supportTicket.findMany({
      where: { id: { in: rows.map((row) => row.ticketId) }, homeId: customer.homeId, status: 'OPEN' },
      select: { id: true, publicReference: true },
    });
    const references = new Map(tickets.map((ticket) => [ticket.id, ticket.publicReference]));
    const requests: Array<{ requestId: string; ticketId: string; publicReference: string; requestedScope: 'TENANT_SCOPE' | 'PROPERTY_SCOPE'; areaIds: string[]; createdAt: string }> = [];
    for (const row of rows) {
      const publicReference = references.get(row.ticketId);
      if (!publicReference) continue;
      const isOwnTenantRequest = customer.role === 'TENANT' && row.requestedScope === 'TENANT_SCOPE'
        && row.targetMembershipId === customer.membershipId && row.targetUserId === customer.id;
      const isPropertyApprover = (customer.role === 'OWNER' || customer.role === 'PROPERTY_MANAGER')
        && row.requestedScope === 'PROPERTY_SCOPE';
      if (!isOwnTenantRequest && !isPropertyApprover) continue;
      const areaIds = Array.isArray(row.canonicalAreaIds) && row.canonicalAreaIds.every((value) => typeof value === 'string')
        ? row.canonicalAreaIds as string[] : [];
      if (new Set(areaIds).size !== areaIds.length) continue;
      const activeAreas = areaIds.length ? await prisma.area.findMany({ where: { id: { in: areaIds }, homeId: customer.homeId, status: 'ACTIVE' }, select: { id: true } }) : [];
      if (activeAreas.length !== areaIds.length) continue;
      if (isOwnTenantRequest && areaIds.length) {
        const grants = await prisma.tenantAreaGrant.findMany({ where: { membershipId: customer.membershipId, homeId: customer.homeId, areaId: { in: areaIds }, revokedAt: null }, select: { areaId: true } });
        if (grants.length !== areaIds.length) continue;
      }
      requests.push({ requestId: row.id, ticketId: row.ticketId, publicReference,
        requestedScope: row.requestedScope, areaIds, createdAt: row.createdAt.toISOString() });
    }
    const projection = { ok: true, requests };
    if (!validateSupportAccessApprovalProjection(projection)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The support approval response failed contract validation');
    return NextResponse.json(projection, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
