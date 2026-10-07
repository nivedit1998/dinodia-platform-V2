import crypto from 'node:crypto';
import { currentNativeDisplayName, normalizedNativeDisplayName } from './nativeDisplayNames';

export type NativeAreaForGrouping = { id: string; originalName: string; overrideName: string | null };

/**
 * Groups are a display projection only. The opaque ID is derived from the
 * normalized explicit label and is never persisted or accepted as authority.
 */
export function nativeDisplayGroups<T extends NativeAreaForGrouping>(areas: readonly T[]) {
  const candidates = new Map<string, NativeAreaForGrouping[]>();
  for (const area of areas) {
    if (area.overrideName === null) continue;
    const key = normalizedNativeDisplayName(area.overrideName);
    if (!key) continue;
    candidates.set(key, [...(candidates.get(key) ?? []), area]);
  }
  const groups = [...candidates.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      id: `display-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
      label: currentNativeDisplayName(members[0].originalName, members[0].overrideName),
      areaIds: members.map(({ id }) => id).sort(),
    }));
  const groupForArea = new Map(groups.flatMap((group) => group.areaIds.map((id) => [id, group] as const)));
  return {
    groups,
    areas: areas.map((area) => {
      const group = groupForArea.get(area.id);
      return {
        ...area,
        displayName: currentNativeDisplayName(area.originalName, area.overrideName),
        displayGroupId: group?.id ?? null,
      };
    }),
  };
}
