import { roomPlaqueHttp } from '@/lib/roomPlaqueHttp';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<Record<string,string>> }) {
  try { return await roomPlaqueHttp(request, await context.params, 'cancel'); }
  catch (error) { return nativeV1ErrorResponse(error); }
}
