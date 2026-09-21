// Stage 1 native app-token issuer. Authority is loaded from the selected
// HomeMembership and TrustedDevice records; User.homeId and User.role are not
// used to grant access. The token is short-lived and contains no device data.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { HomeMembershipRole } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getActiveHomeMembership } from '@/lib/membershipAuthorization';
import { createHubAccessToken } from '@/lib/hubAccessTokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function appSigningKey() {
  const value = String(process.env.DINODIA_APP_TOKEN_PRIVATE_KEY || '').trim();
  return value ? crypto.createPrivateKey(value) : null;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const homeId = Number(body.homeId);
  const trustedDeviceId = typeof body.trustedDeviceId === 'string' ? body.trustedDeviceId.trim() : '';
  if (!Number.isInteger(homeId) || homeId < 1 || !trustedDeviceId) return NextResponse.json({ error: 'homeId and trustedDeviceId are required.' }, { status: 400 });
  const membership = await getActiveHomeMembership(user.id, homeId);
  if (!membership) return NextResponse.json({ error: 'This account has no active membership for that home.' }, { status: 403 });
  const trusted = await prisma.trustedDevice.findFirst({ where: { id: trustedDeviceId, userId: user.id, revokedAt: null }, select: { id: true, sessionVersion: true } });
  if (!trusted) return NextResponse.json({ error: 'This trusted device is not authorised.' }, { status: 403 });
  const hub = await prisma.hubInstall.findUnique({ where: { homeId }, select: { id: true, serial: true, accessPolicyRevision: true } });
  if (!hub) return NextResponse.json({ error: 'This home is not connected to a Dinodia OS hub.' }, { status: 409 });
  const key = appSigningKey();
  if (!key) return NextResponse.json({ error: 'Native app signing is not configured.' }, { status: 503 });
  const areas = membership.role === HomeMembershipRole.TENANT
    ? membership.areaGrants.filter((grant) => !grant.revokedAt).map((grant) => String(grant.areaId))
    : (await prisma.room.findMany({ where: { hubInstallId: hub.id }, select: { id: true } })).map((room) => String(room.id));
  const scope = membership.role === HomeMembershipRole.TENANT ? ['device:read', 'tenant:device-command'] : ['device:read'];
  const token = createHubAccessToken({
    iss: 'dinodia-platform',
    aud: `dinodia-hub:${hub.serial}`,
    sub: `user:${user.id}`,
    sid: crypto.randomUUID(),
    membershipId: membership.id,
    trustedDeviceId: trusted.id,
    hubInstallId: hub.id,
    homeId,
    householdRole: membership.role,
    areaIds: areas,
    policyRevision: Math.max(membership.policyRevision, hub.accessPolicyRevision),
    scope,
  }, key);
  return NextResponse.json({ ok: true, token, expiresInSeconds: 300, homeId, hubInstallId: hub.id, policyRevision: Math.max(membership.policyRevision, hub.accessPolicyRevision) }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}
