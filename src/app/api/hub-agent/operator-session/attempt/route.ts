import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/**
 * Registers the browser attempt created by the paired hub. This endpoint is
 * deliberately machine-authenticated: Company Portal cannot invent the
 * attempt id or browser binding and a second browser cannot replace it.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const attemptId = String(hub.body.setupAttemptId ?? '').trim();
    const browserBindingHash = String(hub.body.browserBindingHash ?? '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(attemptId) || !/^[a-f0-9]{64}$/.test(browserBindingHash)) {
      throw new Stage1AuthError(400, 'operator_attempt_invalid', 'A valid hub-created setup attempt is required');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.operatorBrowserAttempt.findUnique({ where: { attemptId }, select: { id: true, homeId: true, hubInstallationId: true, browserBindingHash: true, expiresAt: true, consumedAt: true, revokedAt: true } });
      if (existing) {
        if (existing.hubInstallationId !== hub.installation.id || existing.homeId !== hub.installation.homeId || existing.browserBindingHash !== browserBindingHash || existing.revokedAt || existing.consumedAt || existing.expiresAt <= now) {
          throw new Stage1AuthError(409, 'operator_attempt_rejected', 'The setup attempt is already bound or expired');
        }
        return { id: existing.id, attemptId, expiresAt: existing.expiresAt, reused: true };
      }
      const created = await tx.operatorBrowserAttempt.create({ data: { attemptId, homeId: hub.installation.homeId, hubInstallationId: hub.installation.id, browserBindingHash, expiresAt }, select: { id: true, attemptId: true, expiresAt: true } });
      await tx.auditEvent.create({ data: { homeId: hub.installation.homeId, actorType: 'HUB', actorId: hub.installation.id, category: 'SECURITY', action: 'operator_browser_attempt_registered', targetType: 'OperatorBrowserAttempt', targetId: created.id, metadata: { attemptId: created.attemptId, outcome: 'registered', expiresAt: created.expiresAt.toISOString() }, purgeAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000) } });
      return { id: created.id, attemptId: created.attemptId, expiresAt: created.expiresAt, reused: false };
    });
    return NextResponse.json({ ok: true, setupAttemptId: result.attemptId, expiresAt: result.expiresAt }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
