// Architecture: Shared HA area snapshot contract. Keeps heartbeat ingestion and
// Company Portal mutations consistent, including an intentionally empty registry.

export type HaAreaSnapshotEntry = {
  areaId?: string;
  name: string;
};

export type HaAreasSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  areas: HaAreaSnapshotEntry[];
};

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalize a hub area snapshot. An empty `areas` array is valid: it is how a
 * hub reports that its last area has been removed. Returning null for that
 * state leaves stale areas in the platform cache indefinitely.
 */
export function normalizeHaAreasSnapshot(value: unknown): { capturedAt: Date; snapshot: HaAreasSnapshot } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Number(obj.schemaVersion ?? 0) !== 1) return null;
  const capturedAt = parseIsoDate(obj.capturedAt);
  if (!capturedAt) return null;
  if (!Array.isArray(obj.areas)) return null;
  const rawAreas = obj.areas;

  const deduped = new Map<string, HaAreaSnapshotEntry>();
  for (const row of rawAreas.slice(0, 500)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const areaId = typeof entry.areaId === 'string' ? entry.areaId.trim() : '';
    const key = name.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, areaId ? { areaId, name } : { name });
  }

  // An explicitly empty registry is valid. A non-empty but entirely invalid
  // payload is not; do not let malformed data erase a good cached snapshot.
  const areas = Array.from(deduped.values());
  if (rawAreas.length > 0 && areas.length === 0) return null;

  return {
    capturedAt,
    snapshot: {
      schemaVersion: 1,
      capturedAt: capturedAt.toISOString(),
      areas,
    },
  };
}

/**
 * Remove one area from a previously accepted snapshot and advance its
 * timestamp so readers never prefer the deleted value as the newest snapshot.
 */
export function removeAreaFromHaAreasSnapshot(
  value: unknown,
  areaName: string,
  areaId: string | null | undefined,
  capturedAt = new Date()
): HaAreasSnapshot | null {
  const normalized = normalizeHaAreasSnapshot(value);
  if (!normalized) return null;

  const nameKey = areaName.trim().toLowerCase();
  const idKey = typeof areaId === 'string' ? areaId.trim() : '';
  const areas = normalized.snapshot.areas.filter((area) => {
    const sameName = nameKey && area.name.trim().toLowerCase() === nameKey;
    const sameId = idKey && area.areaId === idKey;
    return !sameName && !sameId;
  });

  return {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    areas,
  };
}
