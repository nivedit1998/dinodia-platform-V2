import { Prisma } from '@prisma/client';

const MAX_ENDPOINTS = 500;
const MAX_JSON_BYTES = 32_000;

function text(value: unknown, fallback = '', max = 180) {
  const result = typeof value === 'string' ? value.trim() : '';
  return (result || fallback).slice(0, max);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? [])) as Prisma.InputJsonValue;
}

export type NormalizedNativeEndpoint = {
  endpointId: string;
  deviceId: string;
  channelId: string;
  originalDeviceName: string;
  originalAreaName: string;
  areaId: string;
  manufacturerName: string;
  modelName: string | null;
  description: string;
  displayCategories: Prisma.InputJsonValue;
  capabilities: Prisma.InputJsonValue;
  controlBindings: Prisma.InputJsonValue;
  state: Prisma.InputJsonValue;
  available: boolean;
  sourceUpdatedAt: Date;
};

export function normalizeNativeCatalog(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false as const, reason: 'catalog_not_object' };
  const catalog = value as Record<string, unknown>;
  if (catalog.schemaVersion !== 1) return { ok: false as const, reason: 'unsupported_schema' };
  if (typeof catalog.catalogRevision !== 'string' || !catalog.catalogRevision.trim()) return { ok: false as const, reason: 'missing_revision' };
  if (!Array.isArray(catalog.endpoints) || catalog.endpoints.length > MAX_ENDPOINTS) return { ok: false as const, reason: 'invalid_endpoint_count' };

  const endpoints: NormalizedNativeEndpoint[] = [];
  const seen = new Set<string>();
  for (const raw of catalog.endpoints) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false as const, reason: 'invalid_endpoint' };
    const item = raw as Record<string, unknown>;
    const endpointId = text(item.endpointId, '', 180);
    const deviceId = text(item.deviceId, '', 180);
    const channelId = text(item.channelId, '', 180);
    const areaId = text(item.areaId, '', 180);
    if (!endpointId || !deviceId || !channelId || !areaId || seen.has(endpointId)) return { ok: false as const, reason: 'invalid_endpoint_identity' };
    if (!/^dos_[A-Za-z0-9_-]{16,80}$/.test(endpointId)) return { ok: false as const, reason: 'invalid_endpoint_id' };
    const sourceUpdatedAt = new Date(typeof item.sourceUpdatedAt === 'string' ? item.sourceUpdatedAt : String(catalog.generatedAt || ''));
    if (Number.isNaN(sourceUpdatedAt.getTime())) return { ok: false as const, reason: 'invalid_source_timestamp' };
    const capabilities = jsonValue(Array.isArray(item.capabilities) ? item.capabilities : []);
    const controls = jsonValue(Array.isArray(item.controls) ? item.controls : []);
    const displayCategories = jsonValue(Array.isArray(item.displayCategories) ? item.displayCategories : ['OTHER']);
    const state = jsonValue(Array.isArray(item.state) ? item.state : []);
    if (Buffer.byteLength(JSON.stringify(capabilities)) > MAX_JSON_BYTES || Buffer.byteLength(JSON.stringify(controls)) > MAX_JSON_BYTES || Buffer.byteLength(JSON.stringify(displayCategories)) > MAX_JSON_BYTES || Buffer.byteLength(JSON.stringify(state)) > MAX_JSON_BYTES) return { ok: false as const, reason: 'endpoint_payload_too_large' };
    seen.add(endpointId);
    endpoints.push({
      endpointId,
      deviceId,
      channelId,
      originalDeviceName: text(item.originalDeviceName, 'Dinodia device'),
      originalAreaName: text(item.originalAreaName, 'Home'),
      areaId,
      manufacturerName: text(item.manufacturerName, 'Dinodia'),
      modelName: text(item.modelName, '') || null,
      description: text(item.description, 'Dinodia smart home device'),
      displayCategories,
      capabilities,
      controlBindings: controls,
      state,
      available: item.available !== false,
      sourceUpdatedAt,
    });
  }
  return {
    ok: true as const,
    catalogRevision: catalog.catalogRevision.trim().slice(0, 180),
    generatedAt: new Date(typeof catalog.generatedAt === 'string' ? catalog.generatedAt : Date.now()),
    endpoints,
  };
}
