import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireCustomerAccountSession } from '@/lib/stage1Auth';
import { customerPolicyDecision } from '@/lib/customerPolicy';
import { validateCustomerRequirementsReceipt } from '@/lib/contracts/dinodiaV1';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const account = await requireCustomerAccountSession(request, { allowPasswordChangeOnly: true, allowPolicyGate: true, allowUsernameSetup: true });
    const policyDecision = await customerPolicyDecision(account.id);
    const receipt = { schemaVersion: 'dinodia.v1', ok: true,
      nextAction: account.mustChangePassword ? 'CHANGE_PASSWORD' : account.usernameSelectionRequired ? 'CHOOSE_USERNAME' : policyDecision.nextAction,
      accepted: policyDecision.accepted,
      policy: policyDecision.policy,
    };
    if (!validateCustomerRequirementsReceipt(receipt)) throw new Stage1AuthError(500, 'native_v1_contract_invalid', 'The customer requirements receipt failed validation');
    return NextResponse.json(receipt, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
