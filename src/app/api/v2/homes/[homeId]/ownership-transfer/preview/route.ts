import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { LIFECYCLE_REHEARSAL_REQUIRED, requireCurrentOwnerForDeferredLifecycle } from '@/lib/homeownerLifecycleAvailability';
import { Stage1AuthError } from '@/lib/stage1Auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const { homeId } = await context.params;
    await requireCurrentOwnerForDeferredLifecycle(request, homeId);
    throw new Stage1AuthError(503, LIFECYCLE_REHEARSAL_REQUIRED, 'Ownership transfer preview is unavailable until its Stage 13 safety rehearsal is approved');
  } catch (error) { return nativeV1ErrorResponse(error); }
}
