import { prisma } from '@/lib/prisma';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { deviceBinding, MFA_PURPOSE, mfaFailureError, verifyMfaChallenge } from '@/lib/accountMfa';
import { deviceThumbprint, finishCustomerSignIn, parseMfaVerifyBody } from '@/lib/customerSignIn';

export const dynamic = 'force-dynamic';

/** The second step of a sign-in: the emailed code, the secret the app was given with the password step, and the same phone. */
export async function POST(request: Request) {
  try {
    const parsed = parseMfaVerifyBody(await request.json().catch(() => null));
    if (!parsed) throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A code and trusted-device details are required');
    const result = await verifyMfaChallenge({ challengeId: parsed.challengeId, clientSecret: parsed.clientSecret, code: parsed.code,
      purpose: MFA_PURPOSE.SIGN_IN, bindingHash: deviceBinding(parsed.device.deviceInstallationId, deviceThumbprint(parsed.device.publicKey)) });
    if (!result.ok) throw mfaFailureError(result);
    const account = await prisma.customerAccount.findUnique({ where: { id: result.accountId }, select: { id: true, status: true, emailVerifiedAt: true, securityVersion: true } });
    if (!account || account.status !== 'ACTIVE' || !account.emailVerifiedAt) throw new Stage1AuthError(401, 'customer_credentials_invalid', 'The customer credentials are invalid');
    return await finishCustomerSignIn(account, parsed.device);
  } catch (error) { return nativeV1ErrorResponse(error); }
}
