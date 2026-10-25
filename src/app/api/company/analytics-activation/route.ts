import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, requireEmployeeRecentAuth, Stage1AuthError } from '@/lib/stage1Auth';
import { setAnalyticsActivation } from '@/lib/analyticsActivation';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: Request) {
  try {
    const actor = await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    // Vercel/Next may reconstruct an internal request URL behind its proxy.
    // Trust the configured canonical origin, never an arbitrary forwarded Host.
    const expectedOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
    if (request.headers.get('origin') !== expectedOrigin) throw new Stage1AuthError(403, 'analytics_activation_origin_required');
    const text = await request.text();
    if (Buffer.byteLength(text) > 2048) throw new Stage1AuthError(413, 'analytics_activation_body_invalid');
    let body;
    try { body = JSON.parse(text); } catch { throw new Stage1AuthError(400, 'analytics_activation_body_invalid'); }
    const keys = ['homeId', 'hubInstallationId', 'operationId', 'expectedCloudRevision', 'expectedWriterEnabled', 'expectedCollectionEnabled', 'writerEnabled', 'collectionEnabled'];
    if (!body || Array.isArray(body) || Object.keys(body).sort().join('|') !== keys.sort().join('|')
      || !['homeId', 'hubInstallationId', 'operationId'].every(key => typeof body[key] === 'string' && uuid.test(body[key]))
      || !Number.isSafeInteger(body.expectedCloudRevision) || body.expectedCloudRevision < 1
      || !['expectedWriterEnabled', 'expectedCollectionEnabled', 'writerEnabled', 'collectionEnabled'].every(key => typeof body[key] === 'boolean'))
      throw new Stage1AuthError(400, 'analytics_activation_body_invalid');
    return NextResponse.json(await prisma.$transaction(tx => setAnalyticsActivation(tx, actor, body),
      { maxWait: 8000, timeout: 45000 }), { headers });
  } catch (error) { return authErrorResponse(error); }
}
export async function GET(request: Request) {
  try {
    await requireEmployeeRecentAuth(request, ['CXO', 'SENIOR_OPERATIONS_MANAGER']);
    const url = new URL(request.url), homeId = url.searchParams.get('homeId'), hubInstallationId = url.searchParams.get('hubInstallationId');
    if (!uuid.test(homeId || '') || !uuid.test(hubInstallationId || '')) throw new Stage1AuthError(400, 'analytics_activation_body_invalid');
    const hub = await prisma.hubInstallation.findFirst({ where: { id: hubInstallationId!, homeId: homeId! },
      select: { analyticsWriterEnabled: true, analyticsCollectionEnabled: true, cloudConfigurationRevision: true,
        cloudConfigurationChecksum: true, acknowledgedCloudRevision: true, lastSuccessfulSyncAt: true } });
    if (!hub) throw new Stage1AuthError(404, 'analytics_installation_unavailable');
    return NextResponse.json({ ...hub, acknowledged: hub.acknowledgedCloudRevision === hub.cloudConfigurationRevision }, { headers });
  } catch (error) { return authErrorResponse(error); }
}
