import { POST as updateTransfer } from '../route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try { return await updateTransfer(request, context); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
