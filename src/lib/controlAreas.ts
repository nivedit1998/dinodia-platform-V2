// Architecture: Shared platform helper src/lib/controlAreas.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { Role } from '@prisma/client';

type Params = {
  role: Role;
  accessRules: string[];
  tenantAreaSet: Set<string>;
};

const clean = (areas: string[]) =>
  areas
    .map((a) => a?.trim())
    .filter((a): a is string => !!a && a.length > 0);

export function getControllableAreasForUser({ role, accessRules, tenantAreaSet }: Params): string[] {
  if (role !== Role.TENANT) return [];
  const allowed = new Set<string>();
  for (const area of clean(accessRules)) {
    if (tenantAreaSet.has(area)) allowed.add(area);
  }
  return Array.from(allowed);
}
