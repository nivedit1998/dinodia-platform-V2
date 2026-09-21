// Architecture: signed Hub Agent boundary for starting Alexa account linking.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { authenticateNativeHubEnvelope, nativeHubCapabilityEnabled } from '@/lib/alexaNativeHubAuth';
import { prisma } from '@/lib/prisma';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const SKILL_URL = process.env.ALEXA_SKILL_URL || 'https://www.amazon.co.uk/gp/product/B0GGCC4BDS?nodl=0';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  try {
    const hubInstall = await authenticateNativeHubEnvelope(body || {});
    if (!nativeHubCapabilityEnabled(hubInstall, 'alexaNativeProjectionV1')) return apiFailFromStatus(409, 'This hub does not advertise native Alexa support.');
    const connection = await prisma.alexaHomeConnection.upsert({
      where: { homeId: hubInstall.homeId! },
      create: { homeId: hubInstall.homeId!, hubInstallId: hubInstall.id, status: 'CONNECTING' },
      update: { hubInstallId: hubInstall.id, status: 'CONNECTING', lastErrorCode: null, lastErrorAt: null },
      select: { status: true },
    });
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const connectionRow = await prisma.alexaHomeConnection.findUnique({ where: { homeId: hubInstall.homeId! }, select: { id: true } });
    if (!connectionRow) return apiFailFromStatus(409, 'Alexa connection is not available.');
    await prisma.alexaConnectIntent.create({ data: { id: randomUUID(), connectionId: connectionRow.id, hubInstallId: hubInstall.id, tokenHash, expiresAt } });
    const origin = String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
    const connectUrl = origin ? `${origin}/alexa/connect?intent=${encodeURIComponent(token)}` : SKILL_URL;
    return NextResponse.json({ ok: true, status: connection.status, connectUrl, skillUrl: SKILL_URL, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return apiFailFromStatus(Number((error as { statusCode?: number })?.statusCode || 500), error instanceof Error ? error.message : 'Unable to start Alexa linking.');
  }
}
