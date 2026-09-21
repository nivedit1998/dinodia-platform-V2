// Architecture: server-side Home Assistant adapter shared by API routes, device
// control, monitoring, commissioning and Alexa change-report flows. It chooses
// REST/template/WebSocket operations against the configured HA connection while
// callers keep long-lived credentials on the server. The Hub Agent and iOS app
// have separate local/network adapters; their payloads must remain compatible.

import { classifyDeviceByLabel, LabelCategory } from './labelCatalog';
import { HaWsClient } from '@/lib/haWebSocket';
import { buildHaServiceBypassHeaders } from '@/lib/haServiceBypass';
import { safeLog } from '@/lib/safeLogger';

const DEFAULT_HA_TIMEOUT_MS = 6000;
const TEMPLATE_TIMEOUT_MS = 4000;

export type HaConnectionLike = {
  baseUrl: string;
  longLivedToken: string;
};

export type HAState = {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    [key: string]: unknown;
  };
};

export type TemplateDeviceMeta = {
  entity_id: string;
  area_name: string | null;
  device_id?: string | null;
  labels: string[];
  entity_labels?: string[];
  device_labels?: string[];
};

export type HAEntityRegistryEntry = {
  entity_id: string;
  device_id: string | null;
  area_id?: string | null;
};

export type EnrichedDevice = {
  entityId: string;
  deviceId: string | null;
  name: string;
  state: string;
  areaName: string | null;
  labels: string[];
  entityLabels?: string[];
  deviceLabels?: string[];
  labelCategory: LabelCategory | null;
  domain: string;
  attributes: Record<string, unknown>;
  servicesForTarget?: string[];
};

export type HaDeviceAutomationTrigger = {
  platform?: string;
  domain?: string;
  device_id?: string;
  type?: string;
  subtype?: string;
  entity_id?: string;
  [key: string]: unknown;
};

export type HaDeviceRegistryMetadata = {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  labels?: string[] | null;
  identifiers?: Array<[string, string]> | null;
  config_entries?: string[] | null;
  entry_type?: string | null;
  via_device_id?: string | null;
  integration_domains?: string[];
};

type ServicesForTargetCacheEntry = {
  services: string[];
  fetchedAt: number;
};

type DeviceTriggerCacheEntry = {
  triggers: HaDeviceAutomationTrigger[];
  fetchedAt: number;
};

const SERVICES_FOR_TARGET_CACHE_TTL_MS = 15_000;
const DEVICE_TRIGGER_CACHE_TTL_MS = 30_000;

const globalForServicesCache = globalThis as unknown as {
  __haServicesForTargetCache?: Map<string, ServicesForTargetCacheEntry>;
  __haDeviceTriggerCache?: Map<string, DeviceTriggerCacheEntry>;
};

function getServicesForTargetCache() {
  if (!globalForServicesCache.__haServicesForTargetCache) {
    globalForServicesCache.__haServicesForTargetCache = new Map();
  }
  return globalForServicesCache.__haServicesForTargetCache;
}

function buildServicesCacheKey(ha: HaConnectionLike, entityId: string) {
  return `${ha.baseUrl}::${entityId}`;
}

function getDeviceTriggerCache() {
  if (!globalForServicesCache.__haDeviceTriggerCache) {
    globalForServicesCache.__haDeviceTriggerCache = new Map();
  }
  return globalForServicesCache.__haDeviceTriggerCache;
}

function buildDeviceTriggerCacheKey(ha: HaConnectionLike, deviceId: string) {
  return `${ha.baseUrl}::device_triggers::${deviceId}`;
}

function buildTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HA_TIMEOUT_MS
) {
  const { signal, cancel } = buildTimeoutSignal(timeoutMs, init.signal);
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    cancel();
  }
}

export async function callHomeAssistantAPI<T>(
  ha: HaConnectionLike,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const url = `${ha.baseUrl}${path}`;
  const { timeoutMs = DEFAULT_HA_TIMEOUT_MS, ...restInit } = init ?? {};
  let res: Response;
  try {
    const serviceHeaders = buildHaServiceBypassHeaders({
      method: restInit.method || 'GET',
      url,
      body: typeof restInit.body === 'string' ? restInit.body : null,
    });
    res = await fetchWithTimeout(
      url,
      {
        ...restInit,
        headers: {
          Authorization: `Bearer ${ha.longLivedToken}`,
          'Content-Type': 'application/json',
          ...serviceHeaders,
          ...(restInit.headers || {}),
        },
      },
      timeoutMs
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HA API timeout after ${timeoutMs}ms on ${path}`);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HA API error ${res.status} on ${path}: ${text}`);
  }
  if (res.status === 204) {
    return null as T;
  }
  const text = await res.text();
  if (!text) {
    return null as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `HA API error: expected JSON response on ${path} but got non-JSON body: ${String(err)}`
    );
  }
}

export async function renderHomeAssistantTemplate<T>(
  ha: HaConnectionLike,
  template: string,
  timeoutMs = TEMPLATE_TIMEOUT_MS
): Promise<T> {
  let res: Response;
  try {
    const body = JSON.stringify({ template });
    res = await fetchWithTimeout(
      `${ha.baseUrl}/api/template`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ha.longLivedToken}`,
          'Content-Type': 'application/json',
          ...buildHaServiceBypassHeaders({
            method: 'POST',
            url: `${ha.baseUrl}/api/template`,
            body,
          }),
        },
        body,
      },
      timeoutMs
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HA template timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HA template error ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchTemplateMeta(
  ha: HaConnectionLike,
  template: string
): Promise<TemplateDeviceMeta[]> {
  if (process.env.SKIP_HA_TEMPLATE_META === 'true') {
    return [];
  }
  try {
    return await renderHomeAssistantTemplate<TemplateDeviceMeta[]>(ha, template);
  } catch (err) {
    safeLog('warn', '[homeAssistant] Template metadata failed; continuing without metadata', {
      error: err,
    });
    return [];
  }
}

export async function getEntityRegistryMap(ha: HaConnectionLike) {
  const map = new Map<string, string | null>();

  // Prefer WS (works on more HA installs). REST 404s on some setups.
  try {
    const client = await HaWsClient.connect(ha);
    try {
      const entries = await client.call<HAEntityRegistryEntry[]>('config/entity_registry/list');
      for (const entry of entries) {
        if (!entry?.entity_id) continue;
        map.set(entry.entity_id, entry.device_id ?? null);
      }
      return map;
    } finally {
      client.close();
    }
  } catch (err) {
    safeLog('warn', '[homeAssistant] Entity registry WS fetch failed; using fallback', {
      error: err,
    });
  }

  // REST fallback (might 404; suppress noisy logs)
  try {
    const registry = await callHomeAssistantAPI<HAEntityRegistryEntry[]>(
      ha,
      '/api/config/entity_registry'
    );
    for (const entry of registry) {
      if (!entry?.entity_id) continue;
      map.set(entry.entity_id, entry.device_id ?? null);
    }
  } catch {
    // ignore
  }

  return map;
}

export async function getServicesForTargetWs(
  ha: HaConnectionLike,
  entityId: string
): Promise<string[]> {
  const normalizedEntityId = String(entityId || '').trim();
  if (!normalizedEntityId) return [];

  const client = await HaWsClient.connect(ha);
  try {
    const result = await client.call<unknown>('get_services_for_target', {
      target: { entity_id: [normalizedEntityId] },
      expand_group: true,
    });

    if (!Array.isArray(result)) return [];

    return result.filter(
      (item): item is string => typeof item === 'string' && item.trim() !== ''
    );
  } finally {
    client.close();
  }
}

export async function getServicesForTargetCached(
  ha: HaConnectionLike,
  entityId: string,
  ttlMs = SERVICES_FOR_TARGET_CACHE_TTL_MS
): Promise<string[]> {
  const normalizedEntityId = String(entityId || '').trim();
  if (!normalizedEntityId) return [];

  const cache = getServicesForTargetCache();
  const key = buildServicesCacheKey(ha, normalizedEntityId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.services;
  }

  const services = await getServicesForTargetWs(ha, normalizedEntityId);
  cache.set(key, { services, fetchedAt: Date.now() });
  return services;
}

export async function getDeviceAutomationTriggers(
  ha: HaConnectionLike,
  deviceId: string,
  timeoutMs = 7000
): Promise<HaDeviceAutomationTrigger[]> {
  const normalized = String(deviceId || '').trim();
  if (!normalized) return [];

  const client = await HaWsClient.connect(ha, timeoutMs);
  try {
    const result = await client.call<HaDeviceAutomationTrigger[]>(
      'device_automation/trigger/list',
      { device_id: normalized },
      timeoutMs
    );
    return Array.isArray(result) ? result : [];
  } finally {
    client.close();
  }
}

export async function getDeviceAutomationTriggersCached(
  ha: HaConnectionLike,
  deviceId: string,
  timeoutMs = 7000,
  ttlMs = DEVICE_TRIGGER_CACHE_TTL_MS
): Promise<HaDeviceAutomationTrigger[]> {
  const normalized = String(deviceId || '').trim();
  if (!normalized) return [];

  const cache = getDeviceTriggerCache();
  const key = buildDeviceTriggerCacheKey(ha, normalized);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.triggers;
  }

  try {
    const triggers = await getDeviceAutomationTriggers(ha, normalized, timeoutMs);
    cache.set(key, { triggers, fetchedAt: Date.now() });
    return triggers;
  } catch (err) {
    safeLog('warn', '[homeAssistant] Device trigger discovery failed; continuing without triggers', {
      deviceId: normalized,
      error: err,
    });
    cache.set(key, { triggers: [], fetchedAt: Date.now() });
    return [];
  }
}

export async function getDeviceRegistryMetadata(
  ha: HaConnectionLike
): Promise<HaDeviceRegistryMetadata[]> {
  const client = await HaWsClient.connect(ha);
  try {
    const [devices, configEntries] = await Promise.all([
      client.call<HaDeviceRegistryMetadata[]>('config/device_registry/list'),
      client
        .call<Array<{ entry_id?: string; domain?: string }>>('config/config_entries/entry/list')
        .catch(() => []),
    ]);
    const domainsByEntry = new Map(
      (configEntries ?? [])
        .filter((entry) => typeof entry?.entry_id === 'string')
        .map((entry) => [entry.entry_id!, entry.domain])
    );

    return (devices ?? [])
      .filter((device) => typeof device?.id === 'string' && device.id.trim().length > 0)
      .map((device) => ({
        ...device,
        id: device.id.trim(),
        integration_domains: (device.config_entries ?? [])
          .map((entryId) => domainsByEntry.get(entryId))
          .filter((domain): domain is string => typeof domain === 'string' && domain.length > 0),
      }));
  } finally {
    client.close();
  }
}

export async function getDevicesWithMetadata(
  ha: HaConnectionLike
): Promise<EnrichedDevice[]> {
  const template = `{% set ns = namespace(result=[]) %}
{% for s in states %}
  {% set did = device_id(s.entity_id) %}
  {% set entity_labels = (labels(s.entity_id) | map('label_name') | list) %}
  {% set device_labels = (labels(did) | map('label_name') | list) if did else [] %}
  {% set labels_list = ((entity_labels + device_labels) | unique | list) %}
  {% set item = {
    "entity_id": s.entity_id,
    "area_name": area_name(s.entity_id),
    "device_id": did,
    "entity_labels": entity_labels,
    "device_labels": device_labels,
    "labels": labels_list
  } %}
  {% set ns.result = ns.result + [item] %}
{% endfor %}
{{ ns.result | tojson }}`;

  const [states, meta, registryMap] = await Promise.all([
    callHomeAssistantAPI<HAState[]>(ha, '/api/states'),
    fetchTemplateMeta(ha, template),
    getEntityRegistryMap(ha),
  ]);

  const metaByEntity = new Map<string, TemplateDeviceMeta>();
  for (const m of meta) {
    metaByEntity.set(m.entity_id, m);
  }

  if (process.env.NODE_ENV !== 'production') {
    safeLog('debug', '[homeAssistant] Template metadata loaded', {
      stateCount: states.length,
      metadataCount: meta.length,
    });
  }

  return states.map((s) => {
    const domain = s.entity_id.split('.')[0] || '';
    const metaEntry = metaByEntity.get(s.entity_id);
    const deviceId = metaEntry?.device_id ?? registryMap.get(s.entity_id) ?? null;
    const labels = (metaEntry?.labels ?? []).filter(
      (label): label is string => typeof label === 'string' && label.trim() !== ''
    );
    const entityLabels = (metaEntry?.entity_labels ?? []).filter(
      (label): label is string => typeof label === 'string' && label.trim() !== ''
    );
    const deviceLabels = (metaEntry?.device_labels ?? []).filter(
      (label): label is string => typeof label === 'string' && label.trim() !== ''
    );
    const labelCategory =
      classifyDeviceByLabel(labels) ?? classifyDeviceByLabel([domain]);

    return {
      entityId: s.entity_id,
      deviceId,
      name: s.attributes.friendly_name ?? s.entity_id,
      state: s.state,
      areaName: metaEntry?.area_name ?? null,
      labels,
      entityLabels,
      deviceLabels,
      labelCategory,
      domain,
      attributes: s.attributes ?? {},
    };
  });
}

type TemplateLabeledDeviceState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  area_name: string | null;
  device_id?: string | null;
  labels: string[];
  entity_labels?: string[];
  device_labels?: string[];
};

type TemplateLabelDevice = {
  device_id: string;
  entity_id: string | null;
  name: string;
  area_name: string | null;
  labels: string[];
};

export async function getLabeledDevicesWithMetadata(
  ha: HaConnectionLike
): Promise<EnrichedDevice[]> {
  if (process.env.SKIP_HA_TEMPLATE_META === 'true') {
    return [];
  }

  const template = `{% set ns = namespace(result=[]) %}
{% for s in states %}
  {% set did = device_id(s.entity_id) %}
  {% set entity_labels = (labels(s.entity_id) | map('label_name') | list) %}
  {% set device_labels = (labels(did) | map('label_name') | list) if did else [] %}
  {% set labels_list = ((entity_labels + device_labels) | unique | list) %}
  {% if labels_list | length > 0 %}
    {% set item = {
      "entity_id": s.entity_id,
      "state": s.state,
      "attributes": s.attributes,
      "area_name": area_name(s.entity_id),
      "device_id": did,
      "entity_labels": entity_labels,
      "device_labels": device_labels,
      "labels": labels_list
    } %}
    {% set ns.result = ns.result + [item] %}
  {% endif %}
{% endfor %}
{{ ns.result | tojson }}`;

  const labeled = await renderHomeAssistantTemplate<TemplateLabeledDeviceState[]>(ha, template);
  const anyMissingDeviceId = labeled.some((m) => !m.device_id);

  const registryMap = anyMissingDeviceId
    ? await getEntityRegistryMap(ha)
    : new Map<string, string | null>();

  if (process.env.NODE_ENV !== 'production') {
    safeLog('debug', '[homeAssistant] Labeled devices template loaded', {
      labeledCount: labeled.length,
      missingDeviceId: anyMissingDeviceId,
    });
  }

  return labeled.map((entry) => {
    const domain = entry.entity_id.split('.')[0] || '';
    const deviceId =
      entry.device_id ?? registryMap.get(entry.entity_id) ?? null;
    const labels = Array.isArray(entry.labels)
      ? entry.labels
          .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      : [];
    const entityLabels = Array.isArray(entry.entity_labels)
      ? entry.entity_labels.filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      : [];
    const deviceLabels = Array.isArray(entry.device_labels)
      ? entry.device_labels.filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      : [];
    const labelCategory =
      classifyDeviceByLabel(labels) ?? classifyDeviceByLabel([domain]);

    const friendlyNameRaw = entry.attributes?.['friendly_name'];
    const friendlyName = typeof friendlyNameRaw === 'string' ? friendlyNameRaw : undefined;

    return {
      entityId: entry.entity_id,
      deviceId,
      name: friendlyName ?? entry.entity_id,
      state: entry.state,
      areaName: entry.area_name ?? null,
      labels,
      entityLabels,
      deviceLabels,
      labelCategory,
      domain,
      attributes: entry.attributes ?? {},
    };
  });
}

export async function getDevicesWithLabelMetadata(
  ha: HaConnectionLike,
  labelName: string
): Promise<TemplateLabelDevice[]> {
  const normalizedLabel = String(labelName ?? '').trim();
  if (!normalizedLabel) return [];

  const template = `{% set ns = namespace(result=[]) %}
{% for device_id in label_devices(${JSON.stringify(normalizedLabel)}) %}
  {% set entities = device_entities(device_id) %}
  {% set entity_id = (entities | first) if (entities | length > 0) else none %}
  {% set item = {
    "device_id": device_id,
    "entity_id": entity_id,
    "name": device_name(device_id),
    "area_name": area_name(device_id),
    "labels": (labels(device_id) | map('label_name') | list)
  } %}
  {% set ns.result = ns.result + [item] %}
{% endfor %}
{{ ns.result | tojson }}`;

  try {
    return await renderHomeAssistantTemplate<TemplateLabelDevice[]>(ha, template);
  } catch (err) {
    safeLog('warn', '[homeAssistant] Label device metadata failed; continuing without metadata', {
      labelName,
      error: err,
    });
    return [];
  }
}

export async function callHaService(
  ha: HaConnectionLike,
  domain: string,
  service: string,
  data: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_HA_TIMEOUT_MS,
  options: { returnResponse?: boolean } = {}
) {
  const url = new URL(`${ha.baseUrl}/api/services/${domain}/${service}`);
  if (options.returnResponse) {
    url.searchParams.set('return_response', '');
  }
  let res: Response;
  try {
    const body = JSON.stringify(data);
    res = await fetchWithTimeout(
      url.toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ha.longLivedToken}`,
          'Content-Type': 'application/json',
          ...buildHaServiceBypassHeaders({
            method: 'POST',
            url: url.toString(),
            body,
          }),
        },
        body,
      },
      timeoutMs
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`HA service timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HA service error ${res.status}: ${text}`);
  }
  try {
    const parsed = await res.json();
    if (!options.returnResponse) {
      return parsed;
    }
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    const responseKey = `${domain}.${service}`;
    const object = parsed as Record<string, unknown>;
    const looksLikeServicePayload = (value: unknown) => {
      if (!value || typeof value !== 'object') return false;
      const payload = value as Record<string, unknown>;
      return (
        'bindings' in payload ||
        'binding' in payload ||
        'capability' in payload ||
        'trigger_devices' in payload ||
        'removed' in payload ||
        'routed' in payload ||
        'handled' in payload
      );
    };
    const candidateContainers: Array<Record<string, unknown> | undefined> = [
      object.service_response as Record<string, unknown> | undefined,
      object.result as Record<string, unknown> | undefined,
      object.response as Record<string, unknown> | undefined,
      object.data as Record<string, unknown> | undefined,
      object,
    ];

    for (const container of candidateContainers) {
      if (!container) continue;
      const direct = container[responseKey] ?? container[service];
      if (direct !== undefined) {
        return direct;
      }
      if (looksLikeServicePayload(container)) {
        return container;
      }
      const nestedResponse = container.service_response as Record<string, unknown> | undefined;
      if (nestedResponse) {
        const nested = nestedResponse[responseKey] ?? nestedResponse[service];
        if (nested !== undefined) {
          return nested;
        }
        if (looksLikeServicePayload(nestedResponse)) {
          return nestedResponse;
        }
      }
      const nestedResult = container.result as Record<string, unknown> | undefined;
      if (nestedResult) {
        const nested = nestedResult[responseKey] ?? nestedResult[service];
        if (nested !== undefined) {
          return nested;
        }
        if (looksLikeServicePayload(nestedResult)) {
          return nestedResult;
        }
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function fetchHaState(
  ha: HaConnectionLike,
  entityId: string
): Promise<HAState> {
  return callHomeAssistantAPI<HAState>(ha, `/api/states/${entityId}`);
}
