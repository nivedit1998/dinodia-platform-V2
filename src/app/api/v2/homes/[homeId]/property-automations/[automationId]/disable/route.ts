import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { mutatePropertyAutomation } from '@/lib/nativeAutomations/propertyManagement';
import { NativeAutomationError } from '@/lib/nativeAutomations/validation';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = new Set(['safety', 'conflict', 'access', 'other']);

export async function POST(request: Request, context: { params: Promise<{ homeId: string; automationId: string }> }) {
  try {
    const actor = await requireCustomerSelectedHome(request);
    const { homeId, automationId } = await context.params;
    if (!UUID.test(homeId) || !UUID.test(automationId) || homeId !== actor.homeId
      || !['OWNER', 'PROPERTY_MANAGER'].includes(actor.role) || actor.credentialKind !== 'account_access') {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Property automation management is unavailable');
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 8 * 1024) throw new NativeAutomationError(413, 'AUTOMATION_INVALID', 'The request is too large');
    let body: unknown; try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The disable request is invalid');
    const value = body as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'expectedAutomationRevision,expectedManagementRevision,proof,reason'
      || !Number.isSafeInteger(value.expectedAutomationRevision) || Number(value.expectedAutomationRevision) < 1
      || !Number.isSafeInteger(value.expectedManagementRevision) || Number(value.expectedManagementRevision) < 1
      || typeof value.proof !== 'string' || value.proof.length < 20 || value.proof.length > 4096
      || !REASONS.has(String(value.reason))) throw new NativeAutomationError(400, 'AUTOMATION_INVALID', 'The current revision, reason and fresh confirmation are required');
    const receipt = await mutatePropertyAutomation({ actor, automationId, operation: 'disable',
      expectedAutomationRevision: Number(value.expectedAutomationRevision), expectedManagementRevision: Number(value.expectedManagementRevision),
      proof: value.proof, reason: String(value.reason), idempotencyKey: request.headers.get('idempotency-key') ?? '' });
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof NativeAutomationError) return nativeV1ErrorResponse(Object.assign(error, { status: error.status }));
    return nativeV1ErrorResponse(error);
  }
}
