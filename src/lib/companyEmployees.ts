// Architecture: Shared platform helper src/lib/companyEmployees.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { randomBytes } from 'crypto';
import { Role } from '@prisma/client';
import { getAppUrl } from '@/lib/authChallenges';
import { hashPassword } from '@/lib/auth';
import { COMPANY_PORTAL_ROLE_LABELS, COMPANY_PORTAL_ROLES, type CompanyPortalRole } from '@/lib/companyPortalAccess';
import { buildCompanyEmployeeWelcomeEmail } from '@/lib/emailTemplates';
import { sendEmail } from '@/lib/email';

export type CompanyEmployeeRecord = {
  id: number;
  username: string;
  email: string | null;
  phoneNumber: string | null;
  role: CompanyPortalRole;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function isCompanyEmployeeRole(role: Role | null | undefined): role is CompanyPortalRole {
  return COMPANY_PORTAL_ROLES.includes(role as CompanyPortalRole);
}

export function getRoleLabel(role: CompanyPortalRole | Role | null | undefined): string {
  if (!role || !isCompanyEmployeeRole(role)) return 'Company User';
  return COMPANY_PORTAL_ROLE_LABELS[role];
}

export function generateTemporaryPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[bytes[index] % alphabet.length];
  }
  return output;
}

export async function hashTemporaryPassword(password: string) {
  return hashPassword(password);
}

export function normalizeCompanyEmail(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeCompanyUsername(value: string) {
  return value.trim();
}

export async function sendCompanyEmployeeWelcomeEmail(params: {
  to: string;
  username: string;
  role: CompanyPortalRole;
  temporaryPassword: string;
  isPasswordReset?: boolean;
}) {
  const appUrl = getAppUrl().replace(/\/$/, '');
  const loginUrl = `${appUrl}/companylogin/login`;
  const emailContent = buildCompanyEmployeeWelcomeEmail({
    loginUrl,
    username: params.username,
    roleLabel: getRoleLabel(params.role),
    temporaryPassword: params.temporaryPassword,
    isPasswordReset: params.isPasswordReset,
  });

  await sendEmail({
    to: params.to,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  });
}

export function serializeCompanyEmployee(user: {
  id: number;
  username: string;
  email: string | null;
  phoneNumber: string | null;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): CompanyEmployeeRecord {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    phoneNumber: user.phoneNumber,
    role: user.role as CompanyPortalRole,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    passwordChangedAt: user.passwordChangedAt ? user.passwordChangedAt.toISOString() : null,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
