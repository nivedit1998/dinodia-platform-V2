// Architecture: API boundary /admin/home/contacts; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { AuditEventType, Role } from '@prisma/client';
import { apiFailFromStatus } from '@/lib/apiError';
import { prisma } from '@/lib/prisma';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { requireTrustedAdminDevice, toTrustedDeviceResponse } from '@/lib/deviceAuth';
import { clearPropertyManagerEmail, getPropertyManagerEmail, setPropertyManagerEmail } from '@/lib/homeContacts';

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolveAdmin(req: NextRequest): Promise<{ userId: number; homeId: number } | NextResponse | null> {
  const me = await getCurrentUserFromRequest(req);
  if (!me || me.role !== Role.ADMIN) return null;
  try {
    await requireTrustedAdminDevice(req, me.id);
  } catch (err) {
    const deviceError = toTrustedDeviceResponse(err);
    if (deviceError) return deviceError;
    throw err;
  }
  const admin = await prisma.user.findUnique({ where: { id: me.id }, select: { id: true, homeId: true } });
  if (!admin?.homeId) return null;
  return { userId: admin.id, homeId: admin.homeId };
}

export async function GET(req: NextRequest) {
  try {
    const resolved = await resolveAdmin(req);
    if (!resolved) return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
    if (resolved instanceof NextResponse) return resolved;
    const email = await getPropertyManagerEmail(resolved.homeId);
    return NextResponse.json({ ok: true, propertyManagerEmail: email });
  } catch {
    return apiFailFromStatus(500, 'Unable to load contacts right now.');
  }
}

export async function POST(req: NextRequest) {
  const resolved = await resolveAdmin(req);
  if (!resolved) return apiFailFromStatus(401, 'Your session has ended. Please sign in again.');
  if (resolved instanceof NextResponse) return resolved;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiFailFromStatus(400, 'Invalid request. Please try again.');
  }
  const obj = body as Record<string, unknown>;
  const email = typeof obj.propertyManagerEmail === 'string' ? obj.propertyManagerEmail.trim() : '';

  if (!email) {
    await clearPropertyManagerEmail(resolved.homeId);
    await prisma.auditEvent.create({
      data: {
        type: AuditEventType.PROPERTY_MANAGER_UPDATED,
        homeId: resolved.homeId,
        actorUserId: resolved.userId,
        metadata: { action: 'CLEARED' },
      },
    });
    return NextResponse.json({ ok: true, propertyManagerEmail: null });
  }

  if (!EMAIL_REGEX.test(email)) {
    return apiFailFromStatus(400, 'Please enter a valid email address.');
  }

  const updated = await setPropertyManagerEmail(resolved.homeId, email);
  await prisma.auditEvent.create({
    data: {
      type: AuditEventType.PROPERTY_MANAGER_UPDATED,
      homeId: resolved.homeId,
      actorUserId: resolved.userId,
      metadata: { action: 'SET', email: updated.email },
    },
  });

  return NextResponse.json({ ok: true, propertyManagerEmail: updated.email });
}
