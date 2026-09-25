import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const runtime = hub.body.hubRuntime && typeof hub.body.hubRuntime === 'object' ? hub.body.hubRuntime as Record<string, unknown> : {};
    const now = new Date();
    await prisma.hubInstallation.update({ where: { id: hub.installation.id }, data: {
      lastSeenAt: now,
      onlineStateEvaluatedAt: now,
      runtimeVersion: String(runtime.version ?? '').slice(0, 120) || undefined,
      capabilitySummary: runtime.capabilities && typeof runtime.capabilities === 'object' ? runtime.capabilities : undefined,
    } });
    return NextResponse.json({ ok: true, online: true, lastSeenAt: now.toISOString() }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
