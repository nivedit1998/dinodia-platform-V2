// Architecture: Shared platform type contract src/types/device.ts; provides compile-time shapes used by routes, services, UI and synchronized deployment consumers.
export type UIDevice = {
  entityId: string;
  deviceId?: string | null;
  // Latest device battery percent (cloud mode) when available.
  batteryPercent?: number | null;
  name: string;
  state: string;
  area: string | null;
  areaName?: string | null;
  label: string | null;
  labelCategory?: string | null;
  labels?: string[];
  technicalLabels?: string[];
  entityLabels?: string[];
  deviceLabels?: string[];
  sourceName?: string | null;
  sourceAreaName?: string | null;
  sourceTechnicalLabel?: string | null;
  displayName?: string;
  displayAreaName?: string | null;
  parentAreaName?: string | null;
  canonicalLabel?: string | null;
  displayLabel?: string | null;
  displayLabelKey?: string | null;
  ownership?: 'installer' | 'tenant_owned' | 'pending_cleanup';
  tenantVirtualAreaId?: string | null;
  haTechnicalName?: string | null;
  domain: string;
  attributes: Record<string, unknown>;
  servicesForTarget?: string[];
  serviceDomains?: string[];
  blindTravelSeconds?: number | null;
};
