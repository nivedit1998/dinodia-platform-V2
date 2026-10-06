import { POST as changePassword } from '../../../auth/password/change/route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { mobileSessionMutationResponse } from '@/lib/mobileSessionHttp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try { return await mobileSessionMutationResponse(await changePassword(request)); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
