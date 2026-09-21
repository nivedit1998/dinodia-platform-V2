// Architecture: Shared platform helper src/lib/companyPortalAccess.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import type { Route } from 'next';
import { Role } from '@prisma/client';

export const COMPANY_PORTAL_ROLES = [
  Role.INSTALLER,
  Role.SENIOR_OPERATIONS_MANAGER,
  Role.SENIOR_CUSTOMER_SUPPORT,
  Role.CXO,
] as const;

export type CompanyPortalRole = (typeof COMPANY_PORTAL_ROLES)[number];

export type CompanyPortalTab = {
  href: Route;
  label: string;
};

export const COMPANY_PORTAL_ROLE_LABELS: Record<CompanyPortalRole, string> = {
  [Role.INSTALLER]: 'Installer',
  [Role.SENIOR_OPERATIONS_MANAGER]: 'Senior Operations Manager',
  [Role.SENIOR_CUSTOMER_SUPPORT]: 'Senior Customer Support',
  [Role.CXO]: 'CXO',
};

export function isCompanyPortalRole(role: Role | null | undefined): role is CompanyPortalRole {
  return COMPANY_PORTAL_ROLES.includes(role as CompanyPortalRole);
}

export function getCompanyRoleLabel(role: Role | null | undefined): string {
  if (!isCompanyPortalRole(role)) return 'Company User';
  return COMPANY_PORTAL_ROLE_LABELS[role];
}

export function canAccessProvision(role: Role | null | undefined): boolean {
  return role === Role.INSTALLER || role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canLaunchOsOperatorSession(role: Role | null | undefined): boolean {
  return canAccessProvision(role) || role === Role.SENIOR_CUSTOMER_SUPPORT;
}

export function canManageOsOperatorCredential(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canViewOsAccessStatus(role: Role | null | undefined): boolean {
  return isCompanyPortalRole(role);
}

export function canRotateOsOperatorCredential(role: Role | null | undefined): boolean {
  return canManageOsOperatorCredential(role);
}

export function canRevokeOsOperatorCredential(role: Role | null | undefined): boolean {
  return canManageOsOperatorCredential(role);
}

export function canAccessGdpr(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canAccessHomeSupport(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.SENIOR_CUSTOMER_SUPPORT || role === Role.CXO;
}

export function canAccessHomeSupportCxoInsights(role: Role | null | undefined): boolean {
  return role === Role.CXO;
}

export function canAccessEmployeeManagement(role: Role | null | undefined): boolean {
  return role === Role.CXO;
}

export function canAccessSupportAuditSection(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canManageHomeSupportQrRooms(role: Role | null | undefined): boolean {
  return role === Role.INSTALLER || role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canStartRemoveHome(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function canFinishRemoveHome(role: Role | null | undefined): boolean {
  return role === Role.SENIOR_OPERATIONS_MANAGER || role === Role.CXO;
}

export function getCompanyLandingPath(role: Role | null | undefined): Route {
  switch (role) {
    case Role.CXO:
      return '/employeemanagement';
    case Role.SENIOR_CUSTOMER_SUPPORT:
      return '/installer/HomeSupport';
    case Role.SENIOR_OPERATIONS_MANAGER:
    case Role.INSTALLER:
      return '/installer/provision';
    default:
      return '/login';
  }
}

export function getCompanyPortalTabs(role: Role | null | undefined): CompanyPortalTab[] {
  const tabs: CompanyPortalTab[] = [];
  if (canAccessProvision(role)) tabs.push({ href: '/installer/provision', label: 'Provision a Dinodia Hub' });
  if (canAccessGdpr(role)) tabs.push({ href: '/installer/GDPR_Status', label: 'GDPR Status' });
  if (canAccessHomeSupport(role)) tabs.push({ href: '/installer/HomeSupport', label: 'Home Support' });
  if (canAccessEmployeeManagement(role)) tabs.push({ href: '/employeemanagement', label: 'Employee Management' });
  return tabs;
}
