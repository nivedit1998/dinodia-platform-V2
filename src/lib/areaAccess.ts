// Architecture: Shared platform helper src/lib/areaAccess.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { prisma } from '@/lib/prisma';
import { normalizeLookupKey } from '@/lib/displayNormalization';

export type AreaAccessMatcher = {
  hasAreaAccess: (area: string | null | undefined) => boolean;
  displayNameForArea: (area: string | null | undefined) => string | null;
  displayKeyForArea: (area: string | null | undefined) => string | null;
  expandRawAreasForAccess: (areas: Array<string | null | undefined>) => Set<string>;
  resolveRequestedArea: (area: string | null | undefined) => string | null;
  areaOptions: Array<{ haAreaName: string; displayName: string; displayKey: string }>;
  allowedNames: Set<string>;
  allowedKeys: Set<string>;
};

export function cleanAreaName(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.toLowerCase() === 'unassigned') return null;
  return text;
}

export async function buildAreaAccessMatcher(args: {
  haConnectionId: number;
  accessAreas: Array<string | null | undefined>;
}): Promise<AreaAccessMatcher> {
  const allowedNames = new Set<string>();
  const allowedKeys = new Set<string>();
  for (const area of args.accessAreas) {
    const cleaned = cleanAreaName(area);
    if (!cleaned) continue;
    allowedNames.add(cleaned);
    allowedKeys.add(normalizeLookupKey(cleaned));
  }

  const overrides = await prisma.areaDisplayOverride.findMany({
    where: { haConnectionId: args.haConnectionId },
    select: { haAreaName: true, displayName: true, displayKey: true },
  });
  const overrideByOriginal = new Map(overrides.map((row) => [row.haAreaName, row]));
  const rawAreasByDisplayKey = new Map<string, Set<string>>();

  const ensureDisplayKey = (rawArea: string) => {
    const override = overrideByOriginal.get(rawArea);
    const displayName = override?.displayName || rawArea;
    const displayKey = override?.displayKey || normalizeLookupKey(displayName);
    if (!rawAreasByDisplayKey.has(displayKey)) {
      rawAreasByDisplayKey.set(displayKey, new Set<string>());
    }
    rawAreasByDisplayKey.get(displayKey)!.add(rawArea);
    return displayKey;
  };

  for (const rawArea of allowedNames) {
    ensureDisplayKey(rawArea);
  }
  for (const row of overrides) {
    ensureDisplayKey(row.haAreaName);
  }

  const displayNameForArea = (area: string | null | undefined) => {
    const cleaned = cleanAreaName(area);
    if (!cleaned) return null;
    return overrideByOriginal.get(cleaned)?.displayName || cleaned;
  };

  const displayKeyForArea = (area: string | null | undefined) => {
    const cleaned = cleanAreaName(area);
    if (!cleaned) return null;
    return overrideByOriginal.get(cleaned)?.displayKey || normalizeLookupKey(displayNameForArea(cleaned) || cleaned);
  };

  const expandRawAreasForAccess = (areas: Array<string | null | undefined>) => {
    const expanded = new Set<string>();
    for (const area of areas) {
      const cleaned = cleanAreaName(area);
      if (!cleaned) continue;
      expanded.add(cleaned);
      const displayKey = displayKeyForArea(cleaned);
      if (!displayKey) continue;
      const siblings = rawAreasByDisplayKey.get(displayKey);
      siblings?.forEach((rawArea) => expanded.add(rawArea));
    }
    return expanded;
  };

  const expandedAllowedRawAreas = expandRawAreasForAccess(Array.from(allowedNames));
  expandedAllowedRawAreas.forEach((rawArea) => {
    const displayKey = displayKeyForArea(rawArea);
    if (displayKey) allowedKeys.add(displayKey);
  });
  const areaOptions = Array.from(expandedAllowedRawAreas)
    .map((haAreaName) => ({
      haAreaName,
      displayName: displayNameForArea(haAreaName) ?? haAreaName,
      displayKey: displayKeyForArea(haAreaName) ?? normalizeLookupKey(haAreaName),
    }))
    .sort((left, right) => {
      const displayDelta = left.displayName.localeCompare(right.displayName);
      if (displayDelta !== 0) return displayDelta;
      return left.haAreaName.localeCompare(right.haAreaName);
    });

  const hasAreaAccess = (area: string | null | undefined) => {
    const cleaned = cleanAreaName(area);
    if (!cleaned) return false;
    if (expandedAllowedRawAreas.has(cleaned)) return true;
    const displayKey = displayKeyForArea(cleaned);
    return Boolean(displayKey && allowedKeys.has(displayKey));
  };

  const resolveRequestedArea = (area: string | null | undefined) => {
    const cleaned = cleanAreaName(area);
    if (!cleaned) return null;
    if (expandedAllowedRawAreas.has(cleaned)) return cleaned;

    const requestedKey = normalizeLookupKey(cleaned);
    const matches = areaOptions.filter((option) => option.displayKey === requestedKey);
    if (matches.length === 0) return null;

    const exactRaw = matches.find((option) => normalizeLookupKey(option.haAreaName) === requestedKey);
    if (exactRaw) return exactRaw.haAreaName;
    if (matches.length === 1) return matches[0].haAreaName;

    return [...matches]
      .sort((left, right) => left.haAreaName.localeCompare(right.haAreaName))[0]
      ?.haAreaName ?? null;
  };

  return {
    hasAreaAccess,
    displayNameForArea,
    displayKeyForArea,
    expandRawAreasForAccess,
    resolveRequestedArea,
    areaOptions,
    allowedNames,
    allowedKeys,
  };
}
