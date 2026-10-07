import { GET as readActivity } from '../route';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const url = new URL(request.url);
    if ((url.searchParams.has('format') && url.searchParams.get('format') !== 'csv') || url.searchParams.has('cursor')) {
      throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'A bounded CSV export request is required');
    }
    url.searchParams.set('format', 'csv');
    return readActivity(new Request(url, request), context);
  } catch (error) { return nativeV1ErrorResponse(error); }
}
