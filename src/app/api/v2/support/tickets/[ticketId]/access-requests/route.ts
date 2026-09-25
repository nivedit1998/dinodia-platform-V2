import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireEmployee, Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ ticketId: string }> }) {
  try {
    const employee = await requireEmployee(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER', 'INSTALLER', 'SENIOR_CUSTOMER_SUPPORT']);
    const { ticketId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const requestedScope = String(body.requestedScope ?? '').trim() as 'TENANT_SCOPE' | 'PROPERTY_SCOPE';
    const targetMembershipId = body.targetMembershipId == null ? null : String(body.targetMembershipId);
    const areaIds = Array.isArray(body.areaIds) ? body.areaIds.map(String).slice(0, 100) : [];
    const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String).slice(0, 100) : [];
    if (!['TENANT_SCOPE', 'PROPERTY_SCOPE'].includes(requestedScope)) throw new Stage1AuthError(400, 'support_scope_invalid', 'A support scope is required');
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, homeId: true, assignedEmployeeId: true, status: true, selectedMembershipId: true } });
    if (!ticket || ticket.status !== 'OPEN' || ticket.assignedEmployeeId !== employee.id) throw new Stage1AuthError(403, 'support_assignment_required', 'The employee is not assigned to this open ticket');
    if (requestedScope === 'TENANT_SCOPE' && !targetMembershipId) throw new Stage1AuthError(400, 'tenant_membership_required', 'Tenant support scope requires a target membership');
    if (requestedScope === 'PROPERTY_SCOPE') {
      const selectedMembership = await prisma.homeMembership.findUnique({ where: { id: ticket.selectedMembershipId }, select: { id: true, homeId: true, role: true } });
      if (selectedMembership?.homeId === ticket.homeId && selectedMembership.role === 'TENANT') {
        const tenantApproval = await prisma.supportAccessRequest.findFirst({ where: { ticketId, requestedScope: 'TENANT_SCOPE', targetMembershipId: selectedMembership.id, status: { in: ['APPROVED', 'ISSUED', 'REDEEMED'] } }, select: { id: true } });
        if (!tenantApproval) throw new Stage1AuthError(403, 'support_broadening_requires_tenant_approval', 'A tenant ticket needs the tenant approval before property-wide support can be requested');
      }
    }
    const hub = await prisma.hubInstallation.findUnique({ where: { homeId: ticket.homeId }, select: { id: true } });
    if (!hub) throw new Stage1AuthError(409, 'hub_not_available', 'The property has no active hub installation');
    const areas = areaIds.length ? await prisma.area.findMany({ where: { id: { in: areaIds }, homeId: ticket.homeId, status: 'ACTIVE' }, select: { id: true } }) : [];
    if (areas.length !== new Set(areaIds).size) throw new Stage1AuthError(403, 'support_area_scope_invalid', 'Every support area must belong to the selected home and remain active');
    const targetDevices = targetIds.length ? await prisma.nativeDevice.findMany({ where: { id: { in: targetIds }, homeId: ticket.homeId }, select: { id: true, ownerMembershipId: true, managementClass: true, lifecycle: true } }) : [];
    if (targetDevices.length !== new Set(targetIds).size || targetDevices.some((device) => device.lifecycle === 'RETIRED')) throw new Stage1AuthError(403, 'support_target_invalid', 'Every support target must be a current device in the selected home');
    if (requestedScope === 'TENANT_SCOPE') {
      const target = await prisma.homeMembership.findUnique({ where: { id: targetMembershipId! }, select: { id: true, homeId: true, role: true, status: true, customerAccountId: true } });
      if (!target || target.homeId !== ticket.homeId || target.role !== 'TENANT' || target.status !== 'ACTIVE') throw new Stage1AuthError(403, 'tenant_membership_invalid', 'Tenant support must target an active tenant in this home');
      const grants = await prisma.tenantAreaGrant.findMany({ where: { membershipId: target.id, revokedAt: null }, select: { areaId: true } });
      const allowed = new Set(grants.map((grant) => grant.areaId));
      if (areaIds.some((areaId) => !allowed.has(areaId))) throw new Stage1AuthError(403, 'tenant_area_scope_invalid', 'Tenant support cannot request an area outside the tenant grant');
      if (targetDevices.some((device) => device.managementClass === 'TENANT_DEVICE' && device.ownerMembershipId !== target.id)) throw new Stage1AuthError(403, 'tenant_device_scope_invalid', 'Tenant support cannot target another tenant device');
      if (targetDevices.some((device) => device.managementClass === 'PROPERTY_DEVICE' && areaIds.length === 0)) throw new Stage1AuthError(400, 'support_area_required', 'Permanent-device support must name the authorised area');
    } else if (targetMembershipId) {
      throw new Stage1AuthError(400, 'property_scope_target_invalid', 'Property support cannot include a tenant target');
    }
    if (requestedScope === 'PROPERTY_SCOPE' && targetDevices.some((device) => device.managementClass === 'TENANT_DEVICE')) throw new Stage1AuthError(403, 'tenant_device_private', 'Property support cannot target private tenant devices');
    const targetUserId = requestedScope === 'TENANT_SCOPE'
      ? (await prisma.homeMembership.findUnique({ where: { id: targetMembershipId! }, select: { customerAccountId: true } }))?.customerAccountId ?? null
      : null;
    const touchesPropertyInfrastructure = requestedScope === 'PROPERTY_SCOPE' || targetDevices.some((device) => device.managementClass === 'PROPERTY_DEVICE');
    const requestRow = await prisma.supportAccessRequest.create({ data: { ticketId, requestedByEmployeeId: employee.id, homeId: ticket.homeId, hubInstallationId: hub.id, requestedScope, targetMembershipId, targetUserId, canonicalAreaIds: areaIds, targetIds, touchesPropertyInfrastructure }, select: { id: true, status: true, requestedScope: true, touchesPropertyInfrastructure: true, createdAt: true } });
    return NextResponse.json({ ok: true, accessRequest: requestRow }, { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
