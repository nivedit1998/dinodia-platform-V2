// Architecture: API boundary /company/employees/[id]/reset-password; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUser, hashPassword } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isCompanyEmployeeRole } from '@/lib/companyEmployees';
import {
  generateTemporaryPassword,
  sendCompanyEmployeeWelcomeEmail,
  serializeCompanyEmployee,
} from '@/lib/companyEmployees';

function deny(message = 'CXO access required.') {
  return NextResponse.json({ ok: false, error: message }, { status: 403 });
}

async function requireCxo() {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, response: deny('Please sign in again.') };
  if (user.role !== Role.CXO) return { ok: false as const, response: deny('CXO access required.') };
  return { ok: true as const, user };
}

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
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
  if (!current.email) {
    return NextResponse.json({ ok: false, error: 'This employee does not have an email address.' }, { status: 400 });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: {
      passwordHash,
      mustChangePassword: true,
      passwordChangedAt: null,
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

  await sendCompanyEmployeeWelcomeEmail({
    to: current.email,
    username: current.username,
    role: current.role as Parameters<typeof sendCompanyEmployeeWelcomeEmail>[0]['role'],
    temporaryPassword,
    isPasswordReset: true,
  });

  return NextResponse.json({
    ok: true,
    employee: serializeCompanyEmployee(updated),
    temporaryPassword,
  });
}
