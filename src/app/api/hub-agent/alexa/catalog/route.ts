// Architecture: signed Hub Agent boundary for native Alexa catalogue projection.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { authenticateNativeHubEnvelope, nativeHubCapabilityEnabled } from '@/lib/alexaNativeHubAuth';
import { normalizeNativeCatalog } from '@/lib/alexaNativeCatalog';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return apiFailFromStatus(400, 'Invalid body');
  try {
    const hubInstall = await authenticateNativeHubEnvelope(body);
    if (!nativeHubCapabilityEnabled(hubInstall, 'alexaNativeProjectionV1')) return apiFailFromStatus(409, 'This hub does not advertise native Alexa projection support.');
    const normalized = normalizeNativeCatalog((body as Record<string, unknown>).catalog);
    if (!normalized.ok) return apiFailFromStatus(400, `Invalid Alexa catalogue: ${normalized.reason}`);

    const connection = await prisma.alexaHomeConnection.upsert({
      where: { homeId: hubInstall.homeId! },
      create: {
        homeId: hubInstall.homeId!,
        hubInstallId: hubInstall.id,
        status: 'DISCONNECTED',
        projectionSource: 'DINODIA_OS_NATIVE',
        catalogRevision: normalized.catalogRevision,
        catalogUpdatedAt: normalized.generatedAt,
      },
      update: {
        hubInstallId: hubInstall.id,
        projectionSource: 'DINODIA_OS_NATIVE',
        catalogRevision: normalized.catalogRevision,
        catalogUpdatedAt: normalized.generatedAt,
        lastErrorCode: null,
        lastErrorAt: null,
      },
      select: { id: true, status: true },
    });

    await prisma.$transaction(async (tx) => {
      const endpointIds = normalized.endpoints.map((endpoint) => endpoint.endpointId);
      await tx.alexaNativeEndpointProjection.updateMany({ where: { connectionId: connection.id, ...(endpointIds.length ? { endpointId: { notIn: endpointIds } } : {}) }, data: { available: false, retiredAt: new Date(), catalogRevision: normalized.catalogRevision } });
      for (const endpoint of normalized.endpoints) {
        await tx.alexaNativeEndpointProjection.upsert({
          where: { connectionId_endpointId: { connectionId: connection.id, endpointId: endpoint.endpointId } },
          create: { connectionId: connection.id, ...endpoint, catalogRevision: normalized.catalogRevision, retiredAt: null },
          update: { ...endpoint, catalogRevision: normalized.catalogRevision, retiredAt: null },
        });
      }
    });
    return NextResponse.json({ ok: true, catalogRevision: normalized.catalogRevision, endpointCount: normalized.endpoints.length, status: connection.status });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode || 500);
    return apiFailFromStatus(status, error instanceof Error ? error.message : 'Unable to store Alexa catalogue.');
  }
}
