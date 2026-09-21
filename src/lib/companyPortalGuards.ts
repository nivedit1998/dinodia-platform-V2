// Architecture: Shared platform helper src/lib/companyPortalGuards.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import { type NextRequest, NextResponse } from 'next/server';
import { Role } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  canAccessHomeSupport,
  canAccessHomeSupportCxoInsights,
  canAccessProvision,
  canLaunchOsOperatorSession,
  canViewOsAccessStatus,
  canRotateOsOperatorCredential,
  canRevokeOsOperatorCredential,
  canFinishRemoveHome,
  canManageHomeSupportQrRooms,
  canStartRemoveHome,
} from '@/lib/companyPortalAccess';

export type CompanyPortalOperatorContext = {
  userId: number;
  username: string;
  role: Role;
  employeePrincipalId: string;
};

async function requireCompanyOperator(
  req: NextRequest,
  predicate: (role: Role | null | undefined) => boolean,
  unauthorizedMessage = 'Your session has ended. Please sign in again.'
): Promise<CompanyPortalOperatorContext | NextResponse> {
  const me = await getCurrentUserFromRequest(req);
  if (!me) {
    return NextResponse.json({ error: unauthorizedMessage }, { status: 401 });
  }

  // Employee authority is deliberately separate from customer membership.
  // The legacy User.role is only used to locate the signed-in identity; it is
  // never sufficient to grant a Company Portal capability.
  const principal = await prisma.companyEmployeePrincipal.findUnique({
    where: { userId: me.id },
    select: { id: true, role: true, active: true, revokedAt: true },
  });
  if (!principal || !principal.active || principal.revokedAt || !predicate(principal.role)) {
    return NextResponse.json({ error: unauthorizedMessage }, { status: 403 });
  }

  return {
    userId: me.id,
    username: me.username,
    role: principal.role,
    employeePrincipalId: principal.id,
  };
}

export async function requireCompanyHomeSupportViewer(req: NextRequest) {
  return requireCompanyOperator(req, canAccessHomeSupport, 'Company Home Support access required.');
}

export async function requireCompanyHomeSupportCxoViewer(req: NextRequest) {
  return requireCompanyOperator(req, canAccessHomeSupportCxoInsights, 'CXO Home Support access required.');
}

export async function requireCompanyHomeSupportQrOperator(req: NextRequest) {
  return requireCompanyOperator(req, canManageHomeSupportQrRooms, 'Company QR room management access required.');
}

export async function requireCompanyProvisionOperator(req: NextRequest) {
  return requireCompanyOperator(req, canAccessProvision, 'Company provisioning access required.');
}

export async function requireCompanyOsSessionLauncher(req: NextRequest) {
  return requireCompanyOperator(req, canLaunchOsOperatorSession, 'Approved Dinodia OS workflow access required.');
}

export async function requireCompanyOsAccessViewer(req: NextRequest) {
  return requireCompanyOperator(req, canViewOsAccessStatus, 'Company Dinodia OS access required.');
}

export async function requireCompanyOsCredentialRotator(req: NextRequest) {
  return requireCompanyOperator(req, canRotateOsOperatorCredential, 'Only CXO or Senior Operations Manager may rotate OS credentials.');
}

export async function requireCompanyOsCredentialRevoker(req: NextRequest) {
  return requireCompanyOperator(req, canRevokeOsOperatorCredential, 'Only CXO or Senior Operations Manager may revoke OS credentials.');
}

export async function requireCompanyHomeRemovalOperator(
  req: NextRequest,
  mode: 'start' | 'finish' = 'start'
) {
  return requireCompanyOperator(
    req,
    mode === 'finish' ? canFinishRemoveHome : canStartRemoveHome,
    'Company home removal access required.'
  );
}
