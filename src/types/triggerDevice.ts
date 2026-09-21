// Architecture: Shared platform type contract src/types/triggerDevice.ts; provides compile-time shapes used by routes, services, UI and synchronized deployment consumers.
export type TriggerDeviceResolutionState =
  | 'bound'
  | 'target_unavailable'
  | 'target_unresolved'
  | 'unbound'
  | 'unresolved';

export type TriggerDeviceBindingSummary = {
  bindingId: string;
  remoteDeviceId: string;
  targetDeviceId: string | null;
  targetEntityId: string | null;
  targetKind: string | null;
  bindingName: string | null;
  enabled: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type TriggerDeviceCapabilitySummary = {
  targetKind: string;
  domain: string;
  supported: boolean;
  actions: string[];
  description: string;
  reason: string | null;
  targetDeviceId: string | null;
  targetEntityId: string | null;
  source: string;
};

export type TriggerDeviceTargetSummary = {
  targetId: string;
  entityId: string | null;
  deviceId: string | null;
  name: string;
  domain: string;
  areaName: string | null;
  label: string | null;
  labelCategory: string | null;
  state: string;
};

export type TriggerTargetOption = {
  optionId: string;
  targetDeviceId: string;
  targetEntityId: string;
  deviceName: string;
  areaName: string | null;
  label: string;
  domain: string;
  state: string;
};

export type TriggerDeviceSummary = {
  triggerDeviceId: string;
  entityId: string;
  deviceId: string | null;
  name: string;
  state: string;
  area: string | null;
  areaName: string | null;
  label: string | null;
  labelCategory: string | null;
  displayName?: string | null;
  displayAreaName?: string | null;
  parentAreaName?: string | null;
  displayLabel?: string | null;
  sourceTechnicalLabel?: string | null;
  labels: string[];
  domain: string;
  attributes: Record<string, unknown>;
  ownership?: string | null;
  tenantVirtualAreaId?: string | null;
  isTriggerDevice: true;
  binding: TriggerDeviceBindingSummary | null;
  capability: TriggerDeviceCapabilitySummary | null;
  target: TriggerDeviceTargetSummary | null;
  resolutionState: TriggerDeviceResolutionState;
  realActionEntityIds?: string[];
  blockingButtonEntityIds?: string[];
  ignoredHelperEntityIds?: string[];
  triggerClassification?: string;
};
