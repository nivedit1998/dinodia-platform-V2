import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateCustomerMembershipInvitationReceipt, validateCustomerMembershipInvitationRequest } from '@/lib/contracts/dinodiaV1';
import { prisma } from '@/lib/prisma';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { issueCustomerMembershipInvitation } from '@/lib/customerInvitationIssue';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validRequest(value: unknown): value is {
  email: string; areaIds: []; expectedManagementRevision: number; resendInvitationId?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowed = new Set(['email', 'areaIds', 'expectedManagementRevision', 'resendInvitationId']);
  return Object.keys(body).every((key) => allowed.has(key))
    && typeof body.email === 'string' && body.email.trim().length <= 320
    && Array.isArray(body.areaIds) && body.areaIds.length === 0
    && Number.isSafeInteger(body.expectedManagementRevision) && Number(body.expectedManagementRevision) >= 0
    && (body.resendInvitationId === undefined || validUuid(body.resendInvitationId));
}

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    if (!validUuid(homeId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property managers are not available');
    const [home, current] = await Promise.all([
      prisma.home.findUnique({ where: { id: homeId }, select: { id: true, lifecycle: true, installationStatus: true, managementRevision: true } }),
      prisma.homeMembership.findUnique({ where: { customerAccountId_homeId: { customerAccountId: customer.id, homeId } }, select: { id: true, role: true, status: true } }),
    ]);
    if (!home || home.lifecycle !== 'ACTIVE' || home.installationStatus !== 'COMPLETE' || !current || current.status !== 'ACTIVE' || !['OWNER', 'PROPERTY_MANAGER'].includes(current.role)) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property managers are not available');
    }
    const managers = await prisma.homeMembership.findMany({ where: { homeId, role: 'PROPERTY_MANAGER', status: 'ACTIVE' }, orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }], select: { id: true, activatedAt: true, customerAccount: { select: { displayName: true } } }, take: 32 });
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, homeId, managementRevision: home.managementRevision,
      managers: managers.map((manager) => ({ membershipId: manager.id, displayName: manager.customerAccount.displayName, activatedAt: manager.activatedAt.toISOString() })) },
    { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  const startedAt = Date.now();
  let phase = 'authenticate';
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null);
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    if (!validUuid(homeId) || !validRequest(body) || !validateCustomerMembershipInvitationRequest(body, 'PROPERTY_MANAGER') || !/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The property-manager invitation request is invalid');
    }
    phase = 'invitation_service';
    const result = await issueCustomerMembershipInvitation({
      homeId, email: body.email, role: 'PROPERTY_MANAGER', areaIds: [],
      expectedManagementRevision: body.expectedManagementRevision,
      resendInvitationId: body.resendInvitationId ?? null, idempotencyKey,
    }, customer, (nextPhase) => { phase = nextPhase; });
    phase = 'receipt_contract_validation';
    if (!validateCustomerMembershipInvitationReceipt(result.body, homeId, 'PROPERTY_MANAGER')) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The invitation receipt failed contract validation');
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return nativeV1ErrorResponse(error, { operation: 'property_manager_invitation_issue', phase, startedAt });
  }
}
