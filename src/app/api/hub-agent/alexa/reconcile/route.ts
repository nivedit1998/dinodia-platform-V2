// Architecture: signed Hub Agent boundary for native Alexa status reconciliation.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { authenticateNativeHubEnvelope } from '@/lib/alexaNativeHubAuth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const hubInstall = await authenticateNativeHubEnvelope(body || {});
    const connection = await prisma.alexaHomeConnection.findUnique({ where: { homeId: hubInstall.homeId! }, select: { status: true, catalogRevision: true, catalogUpdatedAt: true } });
    return NextResponse.json({ ok: true, status: connection?.status || 'DISCONNECTED', catalogRevision: connection?.catalogRevision || null, catalogUpdatedAt: connection?.catalogUpdatedAt?.toISOString() || null });
  } catch (error) {
    return apiFailFromStatus(Number((error as { statusCode?: number })?.statusCode || 500), error instanceof Error ? error.message : 'Unable to reconcile Alexa.');
  }
}
