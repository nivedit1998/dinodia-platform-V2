// Architecture: Stage 1 masked Dinodia OS credential status. No credential
// plaintext or ciphertext is returned from this route.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyOsAccessViewer } from '@/lib/companyPortalGuards';
import { prisma } from '@/lib/prisma';
import { redactOperatorCredential } from '@/lib/hubOperatorCredentials';

function parseHomeId(raw: string | undefined) { const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : null; }

export async function GET(req: NextRequest, context: { params: Promise<{ homeId: string }> }) {
  const operator = await requireCompanyOsAccessViewer(req);
  if (operator instanceof NextResponse) return operator;
  const homeId = parseHomeId((await context.params).homeId);
  if (!homeId) return apiFailFromStatus(400, 'Invalid home id.');
  const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true, serial: true, accessPolicyRevision: true, publishedOperatorCredentialVersion: true, lastAckedOperatorCredentialVersion: true, operatorRotateEveryMinutes: true, operatorGraceMinutes: true, operatorCredentials: { orderBy: { version: 'desc' }, take: 2, select: { version: true, status: true, issuedAt: true, deliveredAt: true, activatedAt: true, acknowledgedAt: true, graceUntil: true, revokedAt: true } } } });
  if (!hub) return apiFailFromStatus(404, 'No Dinodia OS hub is linked to this home.');
  return NextResponse.json({ ok: true, hub: { hubInstallId: hub.id, serial: hub.serial, accessPolicyRevision: hub.accessPolicyRevision, publishedVersion: hub.publishedOperatorCredentialVersion, acknowledgedVersion: hub.lastAckedOperatorCredentialVersion, rotateEveryMinutes: hub.operatorRotateEveryMinutes, graceMinutes: hub.operatorGraceMinutes, credentials: hub.operatorCredentials.map(redactOperatorCredential) } }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
