// Architecture: API boundary /company/employees/[id]; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { COMPANY_PORTAL_ROLES } from '@/lib/companyPortalAccess';
import {
  isCompanyEmployeeRole,
  normalizeCompanyEmail,
  normalizeCompanyUsername,
  serializeCompanyEmployee,
} from '@/lib/companyEmployees';
import { normalizePhoneNumberE164 } from '@/lib/phoneNumber';

function deny(message = 'CXO access required.') {
  return NextResponse.json({ ok: false, error: message }, { status: 403 });
}

async function requireCxo() {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, response: deny('Please sign in again.') };
  if (user.role !== Role.CXO) return { ok: false as const, response: deny('CXO access required.') };
  return { ok: true as const, user };
}

function parseRole(value: unknown): Role | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  const candidate = normalized as Role;
  return isCompanyEmployeeRole(candidate) ? candidate : null;
}

async function ensureLastCxoProtection(targetId: number, currentRole: Role, nextRole: Role, nextIsActive: boolean) {
  if (currentRole !== Role.CXO || (nextRole === Role.CXO && nextIsActive)) return null;
  const otherActiveCxo = await prisma.user.count({
    where: { role: Role.CXO, isActive: true, id: { not: targetId } },
  });
  if (otherActiveCxo === 0) {
    return NextResponse.json(
      { ok: false, error: 'At least one active CXO must remain.' },
      { status: 409 }
    );
  }
  return null;
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireCxo();
  if (!access.ok) return access.response;

  const { id } = await context.params;
  const targetId = Number(id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid employee id.' }, { status: 400 });
  }

  const current = await prisma.user.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      username: true,
      email: true,
      emailPending: true,
      phoneNumber: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      passwordChangedAt: true,
      emailVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!current || !isCompanyEmployeeRole(current.role)) {
    return NextResponse.json({ ok: false, error: 'Employee not found.' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const username = typeof body.username === 'string' ? normalizeCompanyUsername(body.username) : null;
  const email = typeof body.email === 'string' ? normalizeCompanyEmail(body.email) : null;
  const phoneNumberRaw = typeof body.phoneNumber === 'string' ? body.phoneNumber : null;
  const role = parseRole(body.role);
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : null;

  const nextRole = role ?? current.role;
  const nextIsActive = isActive ?? current.isActive;
  const lastCxoBlock = await ensureLastCxoProtection(targetId, current.role, nextRole, nextIsActive);
  if (lastCxoBlock) return lastCxoBlock;

  if (username) {
    const existing = await prisma.user.findFirst({
      where: {
        username: { equals: username, mode: 'insensitive' },
        id: { not: targetId },
      },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ ok: false, error: 'That username is already in use.' }, { status: 409 });
    }
  }

  if (email) {
    const existingEmail = await prisma.user.findFirst({
      where: {
        role: { in: [...COMPANY_PORTAL_ROLES] },
        id: { not: targetId },
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { emailPending: { equals: email, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    if (existingEmail) {
      return NextResponse.json({ ok: false, error: 'That email is already in use for a company account.' }, { status: 409 });
    }
  }

  if (phoneNumberRaw) {
    const normalizedPhone = normalizePhoneNumberE164(phoneNumberRaw);
    if (!normalizedPhone) {
      return NextResponse.json({ ok: false, error: 'Enter a valid phone number including country code.' }, { status: 400 });
    }
    const existingPhone = await prisma.user.findFirst({
      where: {
        role: { in: [...COMPANY_PORTAL_ROLES] },
        id: { not: targetId },
        phoneNumber: normalizedPhone,
      },
      select: { id: true },
    });
    if (existingPhone) {
      return NextResponse.json({ ok: false, error: 'That phone number is already in use for a company account.' }, { status: 409 });
    }

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: {
        ...(username ? { username } : {}),
        ...(email ? { email, emailPending: null, emailVerifiedAt: new Date() } : {}),
        phoneNumber: normalizedPhone,
        ...(role ? { role } : {}),
        ...(isActive !== null ? { isActive } : {}),
      },
      select: {
        id: true,
        username: true,
        email: true,
        phoneNumber: true,
        role: true,
        isActive: true,
        mustChangePassword: true,
        passwordChangedAt: true,
        emailVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ ok: true, employee: serializeCompanyEmployee(updated) });
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: {
      ...(username ? { username } : {}),
      ...(email ? { email, emailPending: null, emailVerifiedAt: new Date() } : {}),
      ...(role ? { role } : {}),
      ...(isActive !== null ? { isActive } : {}),
    },
    select: {
      id: true,
      username: true,
      email: true,
      phoneNumber: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      passwordChangedAt: true,
      emailVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ ok: true, employee: serializeCompanyEmployee(updated) });
}
