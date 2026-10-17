import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateCustomerMembershipInvitationReceipt, validateCustomerMembershipInvitationRequest } from '@/lib/contracts/dinodiaV1';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { issueCustomerMembershipInvitation } from '@/lib/customerInvitationIssue';

export const dynamic = 'force-dynamic';
export const maxDuration = 40;

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validRequest(value: unknown): value is {
  email: string; areaIds: string[]; expectedManagementRevision: number; resendInvitationId?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowed = new Set(['email', 'areaIds', 'expectedManagementRevision', 'resendInvitationId']);
  return Object.keys(body).every((key) => allowed.has(key))
    && typeof body.email === 'string' && body.email.trim().length <= 320
    && Array.isArray(body.areaIds) && body.areaIds.length > 0 && body.areaIds.length <= 64 && body.areaIds.every(validUuid)
    && Number.isSafeInteger(body.expectedManagementRevision) && Number(body.expectedManagementRevision) >= 0
    && (body.resendInvitationId === undefined || validUuid(body.resendInvitationId));
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  const startedAt = Date.now();
  let phase = 'authenticate';
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null);
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    if (!validUuid(homeId) || !validRequest(body) || !validateCustomerMembershipInvitationRequest(body, 'TENANT') || !/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The tenant invitation request is invalid');
    }
    phase = 'invitation_service';
    const result = await issueCustomerMembershipInvitation({
      homeId, email: body.email, role: 'TENANT', areaIds: body.areaIds,
      expectedManagementRevision: body.expectedManagementRevision,
      resendInvitationId: body.resendInvitationId ?? null, idempotencyKey,
    }, customer, (nextPhase) => { phase = nextPhase; });
    phase = 'receipt_contract_validation';
    if (!validateCustomerMembershipInvitationReceipt(result.body, homeId, 'TENANT')) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The invitation receipt failed contract validation');
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return nativeV1ErrorResponse(error, { operation: 'tenant_invitation_issue', phase, startedAt });
  }
}
