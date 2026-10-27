import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { requireNativeAnalyticsScope, assertNativeAnalyticsScopeCurrent } from '@/lib/nativeAnalyticsAccess';
import { readNativeAnalyticsBootstrap } from '@/lib/nativeAnalyticsQueries';
import { readStateAnalyticsCategories } from '@/lib/multiStateAnalyticsReads';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const { homeId } = await context.params;
    const scope = await requireNativeAnalyticsScope(request, homeId);
    const legacy = await readNativeAnalyticsBootstrap(homeId, scope.timezone);
    const result = request.headers.get('X-Dinodia-Analytics-Contract') === '1'
      ? {...legacy, stateCategories:await readStateAnalyticsCategories(homeId)} : legacy;
    await assertNativeAnalyticsScopeCurrent(scope);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', Vary: 'Authorization, Cookie, X-Dinodia-Home-Id' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
