import { NextResponse } from 'next/server';
import { validateCustomerRoomAccessDecisionReceipt, validateCustomerRoomAccessDecisionRequest } from '@/lib/contracts/dinodiaV1';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { decideHomeRoomAccessRequest, listHomeRoomAccessRequests } from '@/lib/customerRoomAccess';

export const dynamic = 'force-dynamic';

function validId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    if (!validId(homeId)) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Room access requests are not available');
    const requests = await listHomeRoomAccessRequests({ homeId, customer });
    return NextResponse.json({ schemaVersion: 'dinodia.v1', homeId, requests }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const customer = await requireCustomerAccountSession(request);
    const { homeId } = await context.params;
    const body = await request.json().catch(() => null);
    const requestId = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).requestId : null;
    if (!validId(homeId) || typeof requestId !== 'string' || !validId(requestId) || !validateCustomerRoomAccessDecisionRequest(body)) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'The Room access decision is invalid');
    const receipt = await decideHomeRoomAccessRequest({ homeId, customer, ...body });
    if (!validateCustomerRoomAccessDecisionReceipt(receipt, requestId)) throw new Stage1AuthError(500, 'INTERNAL_ERROR', 'The Room access decision response failed contract validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
