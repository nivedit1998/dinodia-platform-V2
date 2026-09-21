import { Role } from '@prisma/client';

export function isAlexaEligibleRole(role: Role | string | null | undefined): boolean {
  return role === Role.TENANT || role === Role.ADMIN;
}

export function alexaScopeForRole(role: Role | string | null | undefined): 'TENANT' | 'HOMEOWNER' {
  return role === Role.ADMIN ? 'HOMEOWNER' : 'TENANT';
}

export function alexaRoleError(): string {
  return 'Alexa is available to homeowner and tenant accounts only.';
}
