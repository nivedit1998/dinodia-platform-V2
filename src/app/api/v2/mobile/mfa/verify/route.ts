import { POST as verifyCookieSession } from '../../../auth/mfa/verify/route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { mobileResponseFromSignIn } from '@/lib/mobileSignInReceipt';

export const dynamic = 'force-dynamic';

/** The phone app's version of the code step: same checks, answered with the app's access and refresh tokens. */
export async function POST(request: Request) {
  try { return await mobileResponseFromSignIn(await verifyCookieSession(request)); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
