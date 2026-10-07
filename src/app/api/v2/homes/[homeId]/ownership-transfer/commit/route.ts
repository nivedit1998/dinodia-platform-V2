import { POST as startTransfer } from '../route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try { return await startTransfer(request, context); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
