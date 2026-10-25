import { NextResponse } from 'next/server';
import { requireEmployee, authErrorResponse } from '@/lib/stage1Auth';
import { listStaffInstallationRequests } from '@/lib/nativeInstallationRequests';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
const ROLES = ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] as const;
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request, [...ROLES]);
    const requests = await listStaffInstallationRequests({ id: employee.id, role: employee.role });
    const employees = employee.role === 'CXO' || employee.role === 'SENIOR_OPERATIONS_MANAGER'
      ? await prisma.companyEmployeeAccount.findMany({ where: { status: 'ACTIVE', role: { in: ['INSTALLER', 'SENIOR_OPERATIONS_MANAGER', 'CXO'] } }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: 'asc' } })
      : [];
    return NextResponse.json({ ok: true, employee: { id: employee.id, role: employee.role }, employees, requests }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
