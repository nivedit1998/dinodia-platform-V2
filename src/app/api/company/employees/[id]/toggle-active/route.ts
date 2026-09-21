// Architecture: API boundary /company/employees/[id]/toggle-active; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isCompanyEmployeeRole, serializeCompanyEmployee } from '@/lib/companyEmployees';

function deny(message = 'CXO access required.') {
  return NextResponse.json({ ok: false, error: message }, { status: 403 });
}

async function requireCxo() {
  const user = await getCurrentUser();
  if (!user) return { ok: false as const, response: deny('Please sign in again.') };
  if (user.role !== Role.CXO) return { ok: false as const, response: deny('CXO access required.') };
  return { ok: true as const, user };
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const access = await requireCxo();
  if (!access.ok) return access.response;

  const { id } = await context.params;
  const targetId = Number(id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ ok: false, error: 'Invalid employee id.' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : null;
  if (isActive === null) {
    return NextResponse.json({ ok: false, error: 'isActive must be true or false.' }, { status: 400 });
  }

  const current = await prisma.user.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      role: true,
      isActive: true,
      username: true,
      email: true,
      phoneNumber: true,
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

  if (current.role === Role.CXO && current.isActive && !isActive) {
    const otherActiveCxos = await prisma.user.count({
      where: { role: Role.CXO, isActive: true, id: { not: targetId } },
    });
    if (otherActiveCxos === 0) {
      return NextResponse.json({ ok: false, error: 'At least one active CXO must remain.' }, { status: 409 });
    }
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { isActive },
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
