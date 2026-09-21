// Architecture: signed Hub Agent boundary for bounded native Alexa state updates.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { authenticateNativeHubEnvelope, nativeHubCapabilityEnabled } from '@/lib/alexaNativeHubAuth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const hubInstall = await authenticateNativeHubEnvelope(body || {});
    if (!nativeHubCapabilityEnabled(hubInstall, 'alexaNativeProjectionV1')) return apiFailFromStatus(409, 'This hub does not advertise native Alexa projection support.');
    const updates = Array.isArray((body as Record<string, unknown>)?.updates) ? (body as Record<string, unknown>).updates as unknown[] : [];
    if (updates.length > 500) return apiFailFromStatus(400, 'Too many Alexa state updates.');
    const connection = await prisma.alexaHomeConnection.findUnique({ where: { homeId: hubInstall.homeId! }, select: { id: true } });
    if (!connection) return apiFailFromStatus(409, 'Alexa catalogue has not been published yet.');
    await prisma.$transaction(async (tx) => {
      for (const raw of updates) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const update = raw as Record<string, unknown>;
        const endpointId = typeof update.endpointId === 'string' ? update.endpointId : '';
        if (!/^dos_[A-Za-z0-9_-]{16,80}$/.test(endpointId)) continue;
        const state = update.state && typeof update.state === 'object' ? update.state : [];
        await tx.alexaNativeEndpointProjection.updateMany({ where: { connectionId: connection.id, endpointId }, data: { state: state as object, available: update.available !== false, sourceUpdatedAt: new Date() } });
      }
      await tx.alexaHomeConnection.update({ where: { id: connection.id }, data: { stateUpdatedAt: new Date() } });
    });
    return NextResponse.json({ ok: true, accepted: updates.length });
  } catch (error) {
    return apiFailFromStatus(Number((error as { statusCode?: number })?.statusCode || 500), error instanceof Error ? error.message : 'Unable to store Alexa state.');
  }
}
