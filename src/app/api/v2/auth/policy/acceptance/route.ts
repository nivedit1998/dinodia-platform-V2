import { NextResponse } from 'next/server';
import { acceptCurrentCustomerPolicy } from '@/lib/customerPolicy';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession, Stage1AuthError } from '@/lib/stage1Auth';
import { validateCustomerPolicyAcceptanceReceipt } from '@/lib/contracts/dinodiaV1';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const principal = await requireCustomerAccountSession(request, { allowPolicyGate: true });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).sort().join(',') !== 'accepted,contentSha256,version'
      || body.accepted !== true || typeof body.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(body.version)
      || typeof body.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentSha256)) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A current reviewed policy version and explicit acceptance are required');
    }
    const result = await acceptCurrentCustomerPolicy({ principal, version: body.version, contentSha256: body.contentSha256, accepted: true });
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, ...result };
    if (!validateCustomerPolicyAcceptanceReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The policy acceptance receipt failed validation');
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
