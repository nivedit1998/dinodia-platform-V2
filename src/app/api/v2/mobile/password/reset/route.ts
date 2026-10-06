import { POST as resetPassword } from '../../../auth/password/reset/route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { mobileSessionMutationResponse } from '@/lib/mobileSessionHttp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try { return await mobileSessionMutationResponse(await resetPassword(request)); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
