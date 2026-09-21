// Architecture: API boundary /admin/tenant; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest, hashPassword } from '@/lib/auth';
import { Role } from '@prisma/client';
import { getUserWithHaConnection } from '@/lib/haConnection';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import {
  collapseRawTenantAreasToDisplayBuckets,
  expandSelectedTenantAreas,
} from '@/lib/adminTenantAreaResolution';

export async function POST(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const { username, password, email, area, areas } = body;

  if (!username || !password) {
    return apiFailFromStatus(400, 'Please enter a username and password.');
  }
  if (typeof email !== 'string' || !email.trim()) {
    return apiFailFromStatus(400, 'Please enter an email address for this tenant.');
  }

  const normalizedEmail = email.trim();
  const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return apiFailFromStatus(400, 'Please enter a valid email address.');
  }

  // Enforce: at most one tenant account can exist for a given email (globally).
  // (The same email may still be used by the homeowner/admin account.)
  const existingTenantEmail = await prisma.user.findFirst({
    where: {
      role: Role.TENANT,
      OR: [
        { email: { equals: normalizedEmail, mode: 'insensitive' } },
        { emailPending: { equals: normalizedEmail, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (existingTenantEmail) {
    return apiFailFromStatus(409, 'That email address is already used by another tenant. Please use a different email.');
  }

  const selectedAreas = (() => {
    const candidateAreas: string[] = [];
    if (Array.isArray(areas)) {
      for (const entry of areas) {
        if (typeof entry === 'string') {
          candidateAreas.push(entry);
        }
      }
    }
    if (typeof area === 'string') {
      candidateAreas.push(area);
    }
    const cleaned = candidateAreas
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    return Array.from(new Set(cleaned));
  })();

  if (selectedAreas.length === 0) {
    return apiFailFromStatus(400, 'Add at least one room or area this tenant can access.');
  }

  let userWithConnection: Awaited<ReturnType<typeof getUserWithHaConnection>>;
  try {
    userWithConnection = await getUserWithHaConnection(me.id);
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  const { user, haConnection } = userWithConnection;
  const normalizedAreas = await expandSelectedTenantAreas({
    homeId: user.homeId!,
    haConnectionId: haConnection.id,
    selectedAreas,
  });

  if (normalizedAreas.length === 0) {
    return apiFailFromStatus(400, 'Add at least one room or area this tenant can access.');
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return apiFailFromStatus(400, 'That username is already in use. Try another one.');
  }

  const passwordHash = await hashPassword(password);

  const tenant = await prisma.user.create({
    data: {
      username,
      passwordHash,
      mustChangePassword:
        (process.env.TENANT_FIRST_LOGIN_PASSWORD_CHANGE_ENABLED ?? '').toLowerCase() === 'true',
      role: Role.TENANT,
      homeId: user.homeId,
      haConnectionId: haConnection.id,
      emailPending: normalizedEmail,
      emailVerifiedAt: null,
      email2faEnabled: false,
    },
  });

  if (normalizedAreas.length > 0) {
    await prisma.accessRule.createMany({
      data: normalizedAreas.map((item) => ({
        userId: tenant.id,
        area: item,
      })),
      skipDuplicates: true,
    });
  }

  return NextResponse.json({ ok: true, tenantId: tenant.id });
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }

  let admin: { id: number; homeId: number | null };
  let haConnectionId: number;
  try {
    const resolved = await getUserWithHaConnection(me.id);
    admin = resolved.user;
    haConnectionId = resolved.haConnection.id;
  } catch {
    return apiFailFromStatus(400, 'Dinodia Hub connection isn’t set up yet for this home.');
  }

  if (!admin) {
    return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  }

  const tenants = await prisma.user.findMany({
    where: { homeId: admin.homeId, role: Role.TENANT },
    select: {
      id: true,
      username: true,
      email: true,
      emailPending: true,
      accessRules: { select: { area: true } },
    },
    orderBy: { username: 'asc' },
  });

  const shaped = await Promise.all(
    tenants.map(async (tenant) => {
      const collapsed = await collapseRawTenantAreasToDisplayBuckets({
        homeId: admin.homeId!,
        haConnectionId,
        rawAreas: tenant.accessRules.map((rule) => rule.area),
      });
      return {
        id: tenant.id,
        username: tenant.username,
        email: tenant.email ?? tenant.emailPending ?? null,
        areas: collapsed.areas,
        rawAreas: collapsed.rawAreas,
        areaDisplayKeys: collapsed.areaDisplayKeys,
        partialAreaBuckets: collapsed.partialAreaBuckets,
      };
    })
  );

  return NextResponse.json({ ok: true, tenants: shaped });
}
