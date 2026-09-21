// Architecture: Shared platform helper src/lib/automationSummaries.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import type { UIDevice } from '@/types/device';

type HaLikeObject = Record<string, unknown>;

function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

function getActionEntity(action: unknown): string | null {
  if (!action || typeof action !== 'object') return null;
  const target = (action as HaLikeObject).target as HaLikeObject | undefined;
  const candidate = target?.entity_id ?? (action as HaLikeObject).entity_id ?? null;
  if (Array.isArray(candidate)) return candidate[0] ?? null;
  return typeof candidate === 'string' ? candidate : null;
}

function getTriggerSummary(trigger: unknown, devices: UIDevice[]): string {
  if (!trigger || typeof trigger !== 'object') return 'Custom trigger';
  const t = trigger as HaLikeObject;
  const entityCandidate = t.entity_id ?? t.entityId;
  const entity = toArray<string>(
    typeof entityCandidate === 'string' || Array.isArray(entityCandidate)
      ? (entityCandidate as string | string[])
      : undefined
  )[0];
  const friendly = devices.find((d) => d.entityId === entity)?.name || entity || 'Unknown entity';
  const platform = typeof t.platform === 'string' ? t.platform : (t.trigger as string | undefined);

  if (platform === 'time') {
    const at = typeof t.at === 'string' ? t.at : '';
    const weekdayValue = t.weekday;
    const weekdays = toArray<string>(
      Array.isArray(weekdayValue) || typeof weekdayValue === 'string'
        ? (weekdayValue as string | string[])
        : undefined
    ).join(', ');
    return `Time: ${at}${weekdays ? ` on ${weekdays}` : ''}`.trim();
  }

  if (platform === 'state') {
    const to = (t.to as string | undefined) ?? (t.state as string | undefined);
    return `State: ${friendly}${to ? ` → ${to}` : ''}`;
  }

  return 'Custom trigger';
}

function getActionSummary(
  action: unknown,
  devices: UIDevice[]
): { summary: string; primaryName?: string } {
  if (!action || typeof action !== 'object') return { summary: 'Custom action' };
  const a = action as HaLikeObject;
  const service = typeof a.service === 'string' ? a.service : undefined;
  const data = (a.data && typeof a.data === 'object' ? a.data : {}) as HaLikeObject;
  const entityId = getActionEntity(a);
  const friendly = devices.find((d) => d.entityId === entityId)?.name || entityId || 'Unknown device';

  if (!service) return { summary: `Custom action on ${friendly}`, primaryName: friendly };

  if (service === 'cover.set_cover_position') {
    const pos = data.position ?? data.percentage;
    return { summary: `Set ${friendly} to ${pos}%`, primaryName: friendly };
  }
  if (service === 'climate.set_temperature') {
    return { summary: `Set ${friendly} temperature to ${data.temperature ?? ''}`, primaryName: friendly };
  }
  if (service === 'light.turn_on') {
    if (data.brightness_pct !== undefined) {
      return { summary: `Set ${friendly} brightness to ${data.brightness_pct}%`, primaryName: friendly };
    }
    return { summary: `Turn on ${friendly}`, primaryName: friendly };
  }
  if (service === 'homeassistant.turn_on') {
    return { summary: `Turn on ${friendly}`, primaryName: friendly };
  }
  if (service === 'homeassistant.turn_off' || service === 'light.turn_off') {
    return { summary: `Turn off ${friendly}`, primaryName: friendly };
  }
  if (service === 'homeassistant.toggle') {
    return { summary: `Toggle ${friendly}`, primaryName: friendly };
  }
  if (service === 'media_player.volume_set') {
    const vol = data.volume_level ? Math.round(Number(data.volume_level) * 100) : undefined;
    return { summary: `Set ${friendly} volume to ${vol ?? ''}%`, primaryName: friendly };
  }
  if (service === 'media_player.media_play_pause') {
    return { summary: `Play/Pause ${friendly}`, primaryName: friendly };
  }
  return { summary: `${service} on ${friendly}`, primaryName: friendly };
}

export function summarizeAutomation(
  auto: { raw?: unknown },
  devices: UIDevice[]
): { triggerSummary: string; actionSummary: string; primaryName?: string } {
  const raw = (auto.raw && typeof auto.raw === 'object' ? (auto.raw as HaLikeObject) : {}) as HaLikeObject;
  const triggers = toArray(raw.triggers ?? raw.trigger);
  const actions = toArray(raw.actions ?? raw.action);
  const triggerSummary = triggers.length > 0 ? getTriggerSummary(triggers[0], devices) : '—';
  const action = actions.length > 0 ? getActionSummary(actions[0], devices) : { summary: '—' as const };
  return {
    triggerSummary,
    actionSummary: action.summary,
    primaryName: action.primaryName,
  };
}
