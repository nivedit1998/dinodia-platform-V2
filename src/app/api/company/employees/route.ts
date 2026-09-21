// Architecture: API boundary /company/employees; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUser, hashPassword } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { COMPANY_PORTAL_ROLES } from '@/lib/companyPortalAccess';
import {
  isCompanyEmployeeRole,
  normalizeCompanyEmail,
  normalizeCompanyUsername,
  sendCompanyEmployeeWelcomeEmail,
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

export async function GET() {
  const access = await requireCxo();
  if (!access.ok) return access.response;

  const employees = await prisma.user.findMany({
    where: { role: { in: [...COMPANY_PORTAL_ROLES] } },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
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

  return NextResponse.json({
    ok: true,
    employees: employees.map(serializeCompanyEmployee),
  });
}

export async function POST(req: NextRequest) {
  const access = await requireCxo();
  if (!access.ok) return access.response;

  const body = await req.json().catch(() => ({}));
  const username = typeof body.username === 'string' ? normalizeCompanyUsername(body.username) : '';
  const email = typeof body.email === 'string' ? normalizeCompanyEmail(body.email) : '';
  const temporaryPassword = typeof body.temporaryPassword === 'string' ? body.temporaryPassword : '';
  const phoneNumberRaw = typeof body.phoneNumber === 'string' ? body.phoneNumber : '';
  const role = parseRole(body.role);

  if (!username || !email || !temporaryPassword || !phoneNumberRaw || !role) {
    return NextResponse.json({ ok: false, error: 'Fill in username, email, temporary password, phone number, and role.' }, { status: 400 });
  }
  if (temporaryPassword.length < 8) {
    return NextResponse.json({ ok: false, error: 'Temporary password must be at least 8 characters.' }, { status: 400 });
  }

  const phoneNumber = normalizePhoneNumberE164(phoneNumberRaw);
  if (!phoneNumber) {
    return NextResponse.json({ ok: false, error: 'Enter a valid phone number including country code.' }, { status: 400 });
  }

  const existingUsername = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existingUsername) {
    return NextResponse.json({ ok: false, error: 'That username is already in use.' }, { status: 409 });
  }

  const existingEmail = await prisma.user.findFirst({
    where: {
      role: { in: [...COMPANY_PORTAL_ROLES] },
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

  const existingPhone = await prisma.user.findFirst({
    where: {
      role: { in: [...COMPANY_PORTAL_ROLES] },
      phoneNumber,
    },
    select: { id: true },
  });
  if (existingPhone) {
    return NextResponse.json({ ok: false, error: 'That phone number is already in use for a company account.' }, { status: 409 });
  }

  const passwordHash = await hashPassword(temporaryPassword);
  const created = await prisma.user.create({
    data: {
      username,
      email,
      emailVerifiedAt: new Date(),
      emailPending: null,
      phoneNumber,
      passwordHash,
      mustChangePassword: true,
      passwordChangedAt: null,
      role,
      isActive: true,
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

  try {
    await sendCompanyEmployeeWelcomeEmail({
      to: email,
      username,
      role: role as Parameters<typeof sendCompanyEmployeeWelcomeEmail>[0]['role'],
      temporaryPassword,
      isPasswordReset: false,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? `Employee was created, but the welcome email failed to send: ${err.message}`
            : 'Employee was created, but the welcome email failed to send.',
        employee: serializeCompanyEmployee(created),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    employee: serializeCompanyEmployee(created),
  });
}
