// Architecture: Shared platform helper src/lib/haDiscovery.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import {
  HaConfigFlowProgress,
  HaConfigFlowStep,
  listConfigFlowProgress,
  sanitizeFlowStep,
} from '@/lib/haConfigFlow';
import type { HaConnectionLike } from '@/lib/homeAssistant';

const DEFAULT_HANDLER_ALLOWLIST = ['samsungtv', 'lgwebos', 'androidtv', 'cast', 'roku'];
const ALLOWED_SOURCES = new Set(['zeroconf', 'ssdp', 'dhcp', 'homekit', 'bluetooth']);

const SAFE_FIELD_KEYS = [
  'code',
  'pin',
  'pair',
  'host',
  'ip',
  'address',
  'device',
  'name',
  'title',
  'label',
  'confirm',
  'port',
  'path',
  'uuid',
  'serial',
  'id',
  'method',
  'protocol',
];

const FORBIDDEN_FIELD_KEYS = ['user', 'email', 'account', 'token', 'password', 'secret', 'client', 'auth'];

export type DiscoveryFlow = {
  flowId: string;
  handler: string;
  source: string | null;
  title: string;
  description: string | null;
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function parseHandlerAllowlist(): Set<string> {
  const env = process.env.TENANT_DISCOVERY_HANDLER_ALLOWLIST;
  if (env && env.trim().length > 0) {
    return new Set(
      env
        .split(',')
        .map((p) => normalize(p))
        .filter(Boolean)
    );
  }
  return new Set(DEFAULT_HANDLER_ALLOWLIST.map((h) => normalize(h)));
}

function formatTitleFromHandler(handler: string) {
  return handler
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sanitizeDiscoveryFlow(flow: HaConfigFlowProgress): DiscoveryFlow | null {
  const flowId = typeof flow.flow_id === 'string' ? flow.flow_id : null;
  const handler = typeof flow.handler === 'string' ? flow.handler : null;
  if (!flowId || !handler) return null;
  const source = typeof flow.context?.source === 'string' ? flow.context.source : null;
  const title =
    (typeof flow.title === 'string' && flow.title.trim().length > 0
      ? flow.title
      : undefined) ?? formatTitleFromHandler(handler);
  const description =
    typeof flow.description === 'string' && flow.description.trim().length > 0
      ? flow.description.trim()
      : 'Discovered on your network';
  return {
    flowId,
    handler,
    source,
    title,
    description,
  };
}

export async function listAllowedDiscoveryFlows(
  ha: HaConnectionLike,
  opts?: { handlerAllowlist?: Set<string> }
): Promise<DiscoveryFlow[]> {
  const allowlist = opts?.handlerAllowlist ?? parseHandlerAllowlist();
  const flows = await listConfigFlowProgress(ha);
  return flows
    .map((flow) => sanitizeDiscoveryFlow(flow))
    .filter((flow): flow is DiscoveryFlow => Boolean(flow))
    .filter(
      (flow) =>
        allowlist.has(normalize(flow.handler)) &&
        (!flow.source || ALLOWED_SOURCES.has(normalize(flow.source)))
    );
}

function normalizeFieldName(name: string) {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function isSafeFieldName(name: string) {
  const normalized = normalizeFieldName(name);
  if (!normalized) return false;
  if (FORBIDDEN_FIELD_KEYS.some((bad) => normalized.includes(bad))) return false;
  return SAFE_FIELD_KEYS.some((allowed) => normalized.includes(normalizeFieldName(allowed)));
}

export function isSafeDiscoverySchema(schema: unknown): boolean {
  if (!schema || !Array.isArray(schema)) return true;
  for (const field of schema) {
    const name =
      field && typeof field === 'object' && typeof (field as Record<string, unknown>).name === 'string'
        ? ((field as Record<string, unknown>).name as string)
        : null;
    if (!name) continue;
    if (!isSafeFieldName(name)) return false;
    const type =
      field && typeof field === 'object' && typeof (field as Record<string, unknown>).type === 'string'
        ? ((field as Record<string, unknown>).type as string).toLowerCase()
        : '';
    if (type.includes('password')) return false;
    if (
      type &&
      !['string', 'boolean', 'select', 'integer', 'float', 'number'].some((t) => type === t)
    ) {
      return false;
    }
  }
  return true;
}

export function sanitizeHaStep(step: unknown): HaConfigFlowStep {
  return sanitizeFlowStep(step);
}
