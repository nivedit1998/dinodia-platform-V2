import crypto from 'node:crypto';
import { prisma } from './prisma';
import { currentNativeDisplayName, normalizedNativeDisplayName } from './nativeDisplayNames';
import { requireCustomerSelectedHome } from './customerSelectedHome';
import { Stage1AuthError } from './stage1Auth';
import { validAnalyticsTimezone, type NativeAnalyticsMetric } from './nativeAnalytics';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requireNativeAnalyticsScope(request: Request, homeId: string) {
  const selected = await requireCustomerSelectedHome(request);
  if (!uuid.test(homeId) || selected.homeId !== homeId || !['OWNER', 'PROPERTY_MANAGER'].includes(selected.role)
    || selected.credentialKind !== 'account_access') {
    throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Analytics is not available for this selected Home');
  }
  const home = await prisma.home.findFirst({ where: {
    id: homeId, lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: { not: null },
  }, select: { id: true, timezone: true } });
  if (!home) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Analytics is not available for this selected Home');
  // Stage 13 owns global customer release. This single global switch also
  // serves as the emergency stop; it is never varied per user or Home.
  if (process.env.DINODIA_NATIVE_ANALYTICS_ENABLED !== 'true') {
    throw new Stage1AuthError(503, 'FEATURE_NOT_ENABLED', 'Measured Home analytics is not enabled yet');
  }
  if (!home.timezone || !validAnalyticsTimezone(home.timezone)) {
    throw new Stage1AuthError(409, 'VALIDATION_FAILED', 'The Home time zone is not configured for measured history');
  }
  return { homeId, timezone: home.timezone, accountId: selected.id, membershipId: selected.membershipId };
}

export async function assertNativeAnalyticsScopeCurrent(scope: { homeId: string; accountId: string; membershipId: string }) {
  const current = await prisma.homeMembership.findFirst({ where: { id: scope.membershipId, customerAccountId: scope.accountId,
    homeId: scope.homeId, status: 'ACTIVE', role: { in: ['OWNER', 'PROPERTY_MANAGER'] }, customerAccount: { status: 'ACTIVE' },
    home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } }, select: { id: true } });
  if (!current) throw new Stage1AuthError(404, 'RESOURCE_NOT_FOUND', 'Analytics is not available for this selected Home');
}

export type AnalyticsArea = { id: string; originalName: string; overrideName: string | null; status: string; revision: number };
export function currentAnalyticsGroups(homeId: string, areas: readonly AnalyticsArea[]) {
  const byName = new Map<string, AnalyticsArea[]>();
  for (const area of areas) {
    if (area.status !== 'ACTIVE' || !area.overrideName) continue;
    const name = normalizedNativeDisplayName(area.overrideName);
    if (!name) continue;
    byName.set(name, [...(byName.get(name) ?? []), area]);
  }
  return [...byName.entries()].filter(([, members]) => members.length > 1).map(([normalizedName, members]) => {
    const areaIds = members.map((area) => area.id).sort();
    const namingRevision = members.map((area) => [area.id, area.revision]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    const digest = crypto.createHash('sha256').update(JSON.stringify([homeId, normalizedName, areaIds, namingRevision])).digest('hex').slice(0, 24);
    return { id: `analytics-group-${digest}`, label: currentNativeDisplayName(members[0].originalName, members[0].overrideName), areaIds };
  });
}

export function metricCategory(metric: string): NativeAnalyticsMetric {
  const value = String(metric).toUpperCase();
  if (['LIGHT', 'BOILER', 'RADIATOR', 'TEMPERATURE'].includes(value)) return value as NativeAnalyticsMetric;
  throw new Stage1AuthError(400, 'VALIDATION_FAILED', 'Choose a supported measured metric');
}

export function parseUuidList(value: string | null, max: number, label: string): string[] | null {
  if (value === null || value === '') return null;
  const ids = value.split(',').map((item) => item.trim());
  if (!ids.length || ids.length > max || ids.some((id) => !uuid.test(id)) || new Set(ids).size !== ids.length) {
    throw new Stage1AuthError(400, 'VALIDATION_FAILED', `The ${label} filter is invalid`);
  }
  return ids;
}

export const ANALYTICS_MAX_ROWS = 50_000;
export const ANALYTICS_MAX_DEVICES = 100;
export const ANALYTICS_MAX_AREAS = 64;
export const ANALYTICS_USAGE_METRICS = ['LIGHT', 'BOILER', 'RADIATOR'] as const;
