import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCustomerSelectedHome } from '@/lib/customerSelectedHome';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { loadHomeownerManagementActivity, managementActivityCsv } from '@/lib/homeownerManagementActivity';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export async function GET(request: Request, context: { params: Promise<{ homeId: string }> }) {
  try {
    const selected = await requireCustomerSelectedHome(request);
    const { homeId } = await context.params;
    const url = new URL(request.url);
    const format = url.searchParams.get('format') ?? 'json';
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 50 : /^\d{1,3}$/.test(limitText) ? Number(limitText) : NaN;
    if (!UUID.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)
      || (format !== 'json' && format !== 'csv') || (format === 'csv' && url.searchParams.has('cursor'))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Management activity is not available for this selected Home');
    }
    const now = new Date();
    const page = await loadHomeownerManagementActivity(prisma, { homeId, actorAccountId: selected.id,
      cursor: url.searchParams.get('cursor'), limit, now });
    if (format === 'csv') {
      // CSV is the bounded 12-month export, not merely the currently visible
      // page. Walk the same keyset pages used by the UI and fail closed rather
      // than silently exporting a truncated file above the explicit cap.
      const exportLimit = 5_000;
      const items = [...page.items];
      let cursor = page.nextCursor;
      while (cursor) {
        if (items.length >= exportLimit) throw new Stage1AuthError(413, 'EXPORT_LIMIT_EXCEEDED', 'This Home has more activity than can be safely exported in one file');
        const next = await loadHomeownerManagementActivity(prisma, { homeId, actorAccountId: selected.id,
          cursor, limit: Math.min(100, exportLimit - items.length), now });
        items.push(...next.items);
        cursor = next.nextCursor;
      }
      const current = await requireCustomerSelectedHome(request);
      if (current.id !== selected.id || current.homeId !== selected.homeId || current.membershipId !== selected.membershipId
        || current.role !== selected.role) throw new Stage1AuthError(403, 'ACCESS_DENIED', 'Selected-Home authority changed during export');
      const exportPage = { ...page, items, nextCursor: null };
      const headers = new Headers({ ...noStore, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dinodia-management-activity-${homeId}.csv"`,
        'X-Dinodia-Activity-As-Of': page.asOf, 'X-Dinodia-Activity-Retention-Start': page.retentionStartAt,
        'X-Dinodia-Activity-Row-Count': String(items.length) });
      return new Response(managementActivityCsv(exportPage), { headers });
    }
    return NextResponse.json(page, { headers: noStore });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
