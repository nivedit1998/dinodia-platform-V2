// Architecture: Shared platform helper src/lib/adminTenantAreaResolution.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { normalizeLookupKey } from '@/lib/displayNormalization';
import { getAdminAreaInventory, type AdminAreaDisplayBucket } from '@/lib/adminConfigurationInventory';

export type AdminTenantPartialAreaBucket = {
  displayName: string;
  displayKey: string;
  upgradeDisplayName: string;
  upgradeDisplayKey: string;
  coveredSourceAreaNames: string[];
  missingSourceAreaNames: string[];
  isPartial: true;
};

export type CollapsedTenantAreas = {
  areas: string[];
  rawAreas: string[];
  areaDisplayKeys: string[];
  partialAreaBuckets: AdminTenantPartialAreaBucket[];
};

function cleanArea(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function bucketMatchesSelection(bucket: AdminAreaDisplayBucket, selection: string) {
  const normalized = normalizeLookupKey(selection);
  if (!normalized) return false;
  return (
    normalized === normalizeLookupKey(bucket.displayKey) ||
    normalized === normalizeLookupKey(bucket.displayName) ||
    bucket.sourceAreaNames.some((rawArea) => normalizeLookupKey(rawArea) === normalized)
  );
}

async function loadAreaBuckets(args: { homeId: number; haConnectionId: number }) {
  const inventory = await getAdminAreaInventory(args);
  const buckets = inventory.areaBuckets ?? [];
  return buckets.map((bucket) => ({
    displayName: bucket.displayName,
    displayKey: bucket.displayKey || normalizeLookupKey(bucket.displayName),
    sourceAreaNames: Array.from(new Set(bucket.sourceAreaNames.map((area) => area.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    ),
  }));
}

export async function expandSelectedTenantAreas(args: {
  homeId: number;
  haConnectionId: number;
  selectedAreas: Array<string | null | undefined>;
}) {
  const buckets = await loadAreaBuckets(args);
  const resolvedRawAreas = new Set<string>();

  for (const selectedArea of args.selectedAreas) {
    const cleaned = cleanArea(selectedArea);
    if (!cleaned) continue;
    const matchingBuckets = buckets.filter((bucket) => bucketMatchesSelection(bucket, cleaned));
    if (matchingBuckets.length > 0) {
      for (const bucket of matchingBuckets) {
        bucket.sourceAreaNames.forEach((rawArea) => resolvedRawAreas.add(rawArea));
      }
      continue;
    }
    resolvedRawAreas.add(cleaned);
  }

  return Array.from(resolvedRawAreas).sort((left, right) => left.localeCompare(right));
}

export async function collapseRawTenantAreasToDisplayBuckets(args: {
  homeId: number;
  haConnectionId: number;
  rawAreas: Array<string | null | undefined>;
}): Promise<CollapsedTenantAreas> {
  const buckets = await loadAreaBuckets(args);
  const cleanedRawAreas = Array.from(
    new Set(args.rawAreas.map((area) => cleanArea(area)).filter((area): area is string => Boolean(area)))
  ).sort((left, right) => left.localeCompare(right));
  const rawAreaSet = new Set(cleanedRawAreas);

  const areas: string[] = [];
  const areaDisplayKeys: string[] = [];
  const partialAreaBuckets: AdminTenantPartialAreaBucket[] = [];
  const consumedRawAreas = new Set<string>();

  for (const bucket of buckets) {
    const coveredSourceAreaNames = bucket.sourceAreaNames.filter((rawArea) => rawAreaSet.has(rawArea));
    if (coveredSourceAreaNames.length === 0) continue;
    const missingSourceAreaNames = bucket.sourceAreaNames.filter((rawArea) => !rawAreaSet.has(rawArea));
    coveredSourceAreaNames.forEach((rawArea) => consumedRawAreas.add(rawArea));
    if (missingSourceAreaNames.length === 0) {
      areas.push(bucket.displayName);
      areaDisplayKeys.push(bucket.displayKey);
      continue;
    }
    partialAreaBuckets.push({
      displayName: bucket.displayName,
      displayKey: bucket.displayKey,
      upgradeDisplayName: bucket.displayName,
      upgradeDisplayKey: bucket.displayKey,
      coveredSourceAreaNames,
      missingSourceAreaNames,
      isPartial: true,
    });
  }

  for (const rawArea of cleanedRawAreas) {
    if (consumedRawAreas.has(rawArea)) continue;
    const displayKey = normalizeLookupKey(rawArea);
    areas.push(rawArea);
    areaDisplayKeys.push(displayKey);
  }

  return {
    areas: Array.from(new Set(areas)),
    rawAreas: cleanedRawAreas,
    areaDisplayKeys: Array.from(new Set(areaDisplayKeys)),
    partialAreaBuckets,
  };
}
