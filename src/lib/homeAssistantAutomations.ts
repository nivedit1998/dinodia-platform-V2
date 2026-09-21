// Architecture: Shared platform helper src/lib/homeAssistantAutomations.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { randomUUID } from 'crypto';
import { callHaService, callHomeAssistantAPI, HaConnectionLike, HAState } from '@/lib/homeAssistant';
import type { DeviceCommandId } from '@/lib/deviceCapabilities';
import { HaWsClient } from '@/lib/haWebSocket';

export type HaAutomationConfig = {
  id: string;
  entityId?: string;
  alias: string;
  description?: string;
  mode?: string;
  enabled?: boolean;
  triggers?: unknown[];
  conditions?: unknown[];
  actions?: unknown[];
  // Back-compat: some payloads may still use these keys.
  trigger?: unknown[];
  condition?: unknown[];
  action?: unknown[];
};

export const DINODIA_MANAGED_MARKER = 'DINODIA_MANAGED=1';

type ScheduleType = 'weekly';

export type AutomationDraftTrigger =
  | {
      type: 'state';
      entityId: string;
      to?: string | number;
    }
  | {
      type: 'device';
      entityId: string;
      mode: 'state_equals' | 'attribute_delta' | 'position_equals';
      to?: string | number;
      direction?: 'increased' | 'decreased';
      attribute?: string | string[];
      weekdays?: string[];
    }
  | {
      type: 'schedule';
      scheduleType: ScheduleType;
      at: string; // HH:MM or HH:MM:SS
      weekdays?: string[]; // mon,tue...
    };

export type AutomationDraftAction =
  | { type: 'toggle'; entityId: string }
  | { type: 'turn_on'; entityId: string }
  | { type: 'turn_off'; entityId: string }
  | { type: 'set_brightness'; entityId: string; value: number }
  | { type: 'set_temperature'; entityId: string; value: number }
  | { type: 'set_cover_position'; entityId: string; value: number }
  | { type: 'device_command'; entityId: string; command: DeviceCommandId; value?: number | string }
  | { type: 'ha_service'; entityId: string; serviceId: string; serviceData?: Record<string, unknown> };

export type AutomationDraft = {
  alias: string;
  description?: string;
  mode?: 'single' | 'restart' | 'queued' | 'parallel';
  enabled?: boolean;
  trigger: AutomationDraftTrigger;
  action: AutomationDraftAction;
};

function safeTimeString(at: string) {
  // Normalize "HH:MM" to "HH:MM:SS"
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(at)) return at;
  if (/^\d{1,2}:\d{2}$/.test(at)) return `${at}:00`;
  throw new Error('Invalid time format; expected HH:MM or HH:MM:SS');
}

function buildStateTrigger(trigger: Extract<AutomationDraftTrigger, { type: 'state' }>) {
  const obj: Record<string, unknown> = {
    trigger: 'state',
    entity_id: trigger.entityId,
  };
  if (trigger.to !== undefined && trigger.to !== '') obj.to = trigger.to;
  return obj;
}

function buildSchedulePieces(trigger: Extract<AutomationDraftTrigger, { type: 'schedule' }>) {
  const at = safeTimeString(trigger.at);
  const baseTrigger: Record<string, unknown> = { trigger: 'time', at };
  const conditions: unknown[] = [];

  const weekdays =
    trigger.weekdays && trigger.weekdays.length > 0
      ? trigger.weekdays
      : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  baseTrigger.weekday = weekdays;

  return { triggers: [baseTrigger], conditions };
}

function normalizeAttributes(attribute: string | string[] | undefined, fallback: string) {
  if (Array.isArray(attribute)) {
    return attribute.filter((attr) => typeof attr === 'string' && attr.length > 0);
  }
  if (typeof attribute === 'string' && attribute.length > 0) return [attribute];
  return [fallback];
}

function buildDeviceTriggerPieces(trigger: Extract<AutomationDraftTrigger, { type: 'device' }>) {
  const triggers: unknown[] = [];
  const conditions: unknown[] = [];

  if (trigger.mode === 'state_equals') {
    triggers.push({ platform: 'state', entity_id: trigger.entityId, to: trigger.to });
  } else if (trigger.mode === 'position_equals') {
    const attributes = normalizeAttributes(trigger.attribute, 'current_position');
    const uniqueAttributes = Array.from(new Set([...attributes, 'position']));
    uniqueAttributes.forEach((attribute) => {
      triggers.push({
        platform: 'state',
        entity_id: trigger.entityId,
        attribute,
        to: trigger.to,
      });
    });
  } else if (trigger.mode === 'attribute_delta') {
    const attributes = normalizeAttributes(trigger.attribute, 'brightness');
    const deltaThreshold = attributes.some((attr) => String(attr).toLowerCase().includes('temp')) ? 1 : 0.01;
    attributes.forEach((attribute) => {
      triggers.push({
        platform: 'state',
        entity_id: trigger.entityId,
        attribute,
      });
    });
    const comparisonOperator =
      trigger.direction === 'increased' ? '>=' : trigger.direction === 'decreased' ? '<=' : null;
    if (comparisonOperator) {
      const comparisons = attributes.map((attribute) => {
        const toValue = `(trigger.to_state.attributes['${attribute}'] | default(0)) if (trigger.to_state is not none and trigger.to_state.attributes is defined) else 0`;
        const fromValue = `(trigger.from_state.attributes['${attribute}'] | default(0)) if (trigger.from_state is not none and trigger.from_state.attributes is defined) else 0`;
        if (trigger.direction === 'increased') {
          return `(${toValue} - ${fromValue}) >= ${deltaThreshold}`;
        }
        return `(${fromValue} - ${toValue}) >= ${deltaThreshold}`;
      });
      if (comparisons.length > 0) {
        conditions.push({
          condition: 'template',
          value_template: `{{ ${comparisons.join(' or ')} }}`,
        });
      }
    }
  }

  if (trigger.weekdays && trigger.weekdays.length > 0) {
    conditions.push({
      condition: 'time',
      weekday: trigger.weekdays,
    });
  }

  return { triggers, conditions };
}

function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max);
}

function buildAction(action: AutomationDraftAction) {
  const target = { entity_id: action.entityId };
  switch (action.type) {
    case 'toggle':
      return { service: 'homeassistant.toggle', target };
    case 'turn_on':
      return { service: 'homeassistant.turn_on', target };
    case 'turn_off':
      return { service: 'homeassistant.turn_off', target };
    case 'set_brightness':
      return {
        service: 'light.turn_on',
        target,
        data: { brightness_pct: clamp(action.value, 0, 100) },
      };
    case 'set_temperature':
      return {
        service: 'climate.set_temperature',
        target,
        data: { temperature: action.value },
      };
    case 'set_cover_position':
      return {
        service: 'cover.set_cover_position',
        target,
        data: { position: clamp(action.value, 0, 100) },
      };
    case 'device_command':
      return buildDeviceCommandAction(action.command, action.entityId, action.value);
    case 'ha_service':
      return {
        service: action.serviceId,
        target,
        data: action.serviceData ?? {},
      };
    default:
      // Exhaustive guard
      throw new Error('Unsupported action');
  }
}

function buildDeviceCommandAction(command: DeviceCommandId, entityId: string, value?: number | string) {
  const target = { entity_id: entityId };
  switch (command) {
    case 'light/toggle':
      return { service: 'homeassistant.toggle', target };
    case 'light/turn_on':
      return { service: 'homeassistant.turn_on', target };
    case 'light/turn_off':
      return { service: 'homeassistant.turn_off', target };
    case 'light/set_brightness':
      return {
        service: 'light.turn_on',
        target,
        data: { brightness_pct: clamp(Number(value ?? 0), 0, 100) },
      };
    case 'blind/set_position':
      return {
        service: 'cover.set_cover_position',
        target,
        data: { position: clamp(Number(value ?? 0), 0, 100) },
      };
    case 'blind/open':
      return { service: 'cover.open_cover', target };
    case 'blind/close':
      return { service: 'cover.close_cover', target };
    case 'media/play_pause':
      return { service: 'media_player.media_play_pause', target };
    case 'media/next':
      return { service: 'media_player.media_next_track', target };
    case 'media/previous':
      return { service: 'media_player.media_previous_track', target };
    case 'media/volume_set':
      return {
        service: 'media_player.volume_set',
        target,
        data: { volume_level: clamp(Number(value ?? 0) / 100, 0, 1) },
      };
    case 'media/volume_up':
      return { service: 'media_player.volume_up', target };
    case 'media/volume_down':
      return { service: 'media_player.volume_down', target };
    case 'tv/turn_on':
    case 'speaker/turn_on':
      return { service: 'media_player.turn_on', target };
    case 'tv/turn_off':
    case 'speaker/turn_off':
      return { service: 'media_player.turn_off', target };
    case 'tv/toggle_power':
    case 'speaker/toggle_power':
      return { service: 'media_player.toggle', target };
    case 'boiler/set_temperature': {
      const temp = Number.isFinite(Number(value)) ? Number(value) : 20;
      return { service: 'climate.set_temperature', target, data: { temperature: temp } };
    }
    case 'boiler/temp_up':
    case 'boiler/temp_down': {
      const temp = Number.isFinite(Number(value)) ? Number(value) : 20;
      return { service: 'climate.set_temperature', target, data: { temperature: temp } };
    }
    default:
      throw new Error('Unsupported device command');
  }
}

export function buildHaAutomationConfigFromDraft(
  draft: AutomationDraft,
  automationId?: string
): HaAutomationConfig {
  const triggerPieces =
    draft.trigger.type === 'state'
      ? { triggers: [buildStateTrigger(draft.trigger)], conditions: [] as unknown[] }
      : draft.trigger.type === 'device'
      ? buildDeviceTriggerPieces(draft.trigger)
      : buildSchedulePieces(draft.trigger);

  const triggers = triggerPieces.triggers;
  const conditions = triggerPieces.conditions ?? [];

  const actions = [buildAction(draft.action)];

  const rawId = automationId || `dinodia_${randomUUID()}`;
  const id = rawId.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();

  return {
    id,
    alias: draft.alias,
    description: draft.description || 'Created via Dinodia',
    mode: draft.mode || 'single',
    triggers,
    conditions,
    actions,
  };
}

export function ensureDinodiaManagedMarker(description?: string) {
  const raw = typeof description === 'string' ? description : '';
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(DINODIA_MANAGED_MARKER)) {
    return lines.join('\n');
  }
  lines.push(DINODIA_MANAGED_MARKER);
  return lines.join('\n');
}

export function hasDinodiaManagedMarker(description?: string) {
  if (typeof description !== 'string') return false;
  return description
    .split('\n')
    .map((line) => line.trim())
    .includes(DINODIA_MANAGED_MARKER);
}

export function stripDinodiaManagedMarker(description?: string) {
  if (typeof description !== 'string') return '';
  return description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== DINODIA_MANAGED_MARKER)
    .join('\n');
}

export async function listAutomationConfigs(ha: HaConnectionLike): Promise<HaAutomationConfig[]> {
  // HA frontend uses per-entity WS `automation/config` + REST save/delete.
  // We list automation entities via /api/states and fetch configs via WS.
  const states = await callHomeAssistantAPI<HAState[]>(ha, '/api/states');
  const automationEntities = states
    .filter((s) => typeof s.entity_id === 'string' && s.entity_id.startsWith('automation.'))
    .filter((s) => !(s.attributes && (s.attributes as Record<string, unknown>).hidden === true));

  const client = await HaWsClient.connect(ha);
  try {
    const results: HaAutomationConfig[] = [];
    // Small concurrency limit to avoid overloading HA.
    const concurrency = 6;
    for (let i = 0; i < automationEntities.length; i += concurrency) {
      const batch = automationEntities.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (state) => {
          const entityId = state.entity_id;
          const response = await client.call<{ config: Record<string, unknown> }>('automation/config', {
            entity_id: entityId,
          });
          const cfg = response?.config ?? {};
          const rawId = typeof cfg.id === 'string' ? cfg.id.trim() : '';
          const id = rawId.length > 0 ? rawId : entityId.slice('automation.'.length);
          const triggersRaw = (cfg.triggers ?? cfg.trigger) as unknown;
          const conditionsRaw = (cfg.conditions ?? cfg.condition) as unknown;
          const actionsRaw = (cfg.actions ?? cfg.action) as unknown;
          const triggers = Array.isArray(triggersRaw) ? triggersRaw : triggersRaw ? [triggersRaw] : [];
          const conditions = Array.isArray(conditionsRaw) ? conditionsRaw : conditionsRaw ? [conditionsRaw] : [];
          const actions = Array.isArray(actionsRaw) ? actionsRaw : actionsRaw ? [actionsRaw] : [];
          return {
            id,
            entityId,
            alias: typeof cfg.alias === 'string' ? cfg.alias : entityId,
            description: typeof cfg.description === 'string' ? cfg.description : '',
            mode: typeof cfg.mode === 'string' ? cfg.mode : 'single',
            enabled: state.state !== 'off',
            triggers,
            conditions,
            actions,
            // Populate singular keys for downstream extractors that still expect them.
            trigger: triggers,
            condition: conditions,
            action: actions,
          } satisfies HaAutomationConfig;
        })
      );
      results.push(...batchResults);
    }
    return results;
  } finally {
    client.close();
  }
}

export async function getAutomationConfig(
  ha: HaConnectionLike,
  automationId: string
): Promise<HaAutomationConfig | null> {
  const normalized = automationId.trim().replace(/^automation\./i, '');
  if (!normalized) return null;
  const configs = await listAutomationConfigs(ha);
  return (
    configs.find((cfg) => cfg.id === normalized) ??
    configs.find((cfg) => cfg.entityId?.toLowerCase() === `automation.${normalized}`.toLowerCase()) ??
    null
  );
}

export async function createAutomation(ha: HaConnectionLike, config: HaAutomationConfig) {
  // HA frontend: POST /api/config/automation/config/<id>
  const payload: Record<string, unknown> = { ...config };
  // Ensure we only send plural keys and required fields
  delete payload.trigger;
  delete payload.condition;
  delete payload.action;
  delete payload.entityId;
  delete payload.enabled;

  await callHomeAssistantAPI<unknown>(ha, `/api/config/automation/config/${encodeURIComponent(config.id)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { id: config.id };
}

export async function updateAutomation(
  ha: HaConnectionLike,
  automationId: string,
  config: HaAutomationConfig
) {
  const payload: Record<string, unknown> = { ...config, id: automationId };
  delete payload.trigger;
  delete payload.condition;
  delete payload.action;
  delete payload.entityId;
  delete payload.enabled;

  await callHomeAssistantAPI<unknown>(ha, `/api/config/automation/config/${encodeURIComponent(automationId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { ok: true };
}

export async function deleteAutomation(ha: HaConnectionLike, automationId: string) {
  await callHomeAssistantAPI<unknown>(ha, `/api/config/automation/config/${encodeURIComponent(automationId)}`, {
    method: 'DELETE',
  });
  return { ok: true };
}

export async function setAutomationEnabled(
  ha: HaConnectionLike,
  automationId: string,
  enabled: boolean
) {
  // Service toggle expects automation entity_id (automation.<id>).
  const entityId = automationId.includes('.') ? automationId : `automation.${automationId}`;
  const service = enabled ? 'turn_on' : 'turn_off';
  await callHaService(ha, 'automation', service, { entity_id: entityId });
}

export function extractEntityIdsFromAutomationConfig(config: HaAutomationConfig) {
  const triggerEntities = new Set<string>();
  const conditionEntities = new Set<string>();
  const actionEntities = new Set<string>();
  const actionDeviceIds = new Set<string>();
  let hasTemplates = false;

  // Normalize singular/plural to arrays for traversal.
  const triggers = Array.isArray(config.triggers)
    ? config.triggers
    : config.trigger
    ? Array.isArray(config.trigger)
      ? config.trigger
      : [config.trigger]
    : [];
  const conditions = Array.isArray(config.conditions)
    ? config.conditions
    : config.condition
    ? Array.isArray(config.condition)
      ? config.condition
      : [config.condition]
    : [];
  const actions = Array.isArray(config.actions)
    ? config.actions
    : config.action
    ? Array.isArray(config.action)
      ? config.action
      : [config.action]
    : [];

  function visit(node: unknown, entityCollector: Set<string>, deviceCollector?: Set<string>) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (node.includes('{{')) {
        hasTemplates = true;
        return;
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, entityCollector, deviceCollector));
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'entity_id' || key === 'entityId') {
          if (typeof value === 'string') {
            if (!value.includes('{{')) entityCollector.add(value);
            else hasTemplates = true;
          } else if (Array.isArray(value)) {
            for (const v of value) {
              if (typeof v === 'string' && !v.includes('{{')) entityCollector.add(v);
              else if (typeof v === 'string') hasTemplates = true;
            }
          }
        } else if (deviceCollector && (key === 'device_id' || key === 'deviceId')) {
          if (typeof value === 'string' && !value.includes('{{')) {
            deviceCollector.add(value);
          } else if (Array.isArray(value)) {
            for (const v of value) {
              if (typeof v === 'string' && !v.includes('{{')) deviceCollector.add(v);
              else if (typeof v === 'string') hasTemplates = true;
            }
          }
        } else if (key === 'target' && typeof value === 'object' && value) {
          const target = value as Record<string, unknown>;
          if (typeof target.entity_id === 'string' && !target.entity_id.includes('{{')) {
            entityCollector.add(target.entity_id);
          } else if (
            Array.isArray(target.entity_id) &&
            target.entity_id.every((v) => typeof v === 'string')
          ) {
            (target.entity_id as string[]).forEach((e) => entityCollector.add(e));
          } else if (typeof target.entity_id === 'string') {
            hasTemplates = true;
          }

          if (deviceCollector && typeof target.device_id === 'string' && !target.device_id.includes('{{')) {
            deviceCollector.add(target.device_id);
          } else if (
            deviceCollector &&
            Array.isArray(target.device_id) &&
            target.device_id.every((v) => typeof v === 'string')
          ) {
            (target.device_id as string[]).forEach((id) => deviceCollector.add(id));
          } else if (typeof target.entity_id === 'string') {
            hasTemplates = true;
          }
        } else {
          visit(value, entityCollector, deviceCollector);
        }
      }
    }
  }

  visit(triggers, triggerEntities);
  visit(conditions, conditionEntities);
  visit(actions, actionEntities, actionDeviceIds);

  return { triggerEntities, conditionEntities, actionEntities, actionDeviceIds, hasTemplates };
}
