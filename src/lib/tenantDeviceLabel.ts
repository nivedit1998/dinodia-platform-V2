// Architecture: Shared platform helper src/lib/tenantDeviceLabel.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export const TENANT_DEVICE_LABEL_ID = 'tenant_device';
export const TENANT_DEVICE_LABEL_NAME = 'Tenant Device';

function normalizeTenantDeviceLabelValue(value: string | null | undefined) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function isTenantDeviceLabelValue(value: string | null | undefined) {
  return normalizeTenantDeviceLabelValue(value) === 'tenant device';
}

export function hasTenantDeviceLabelValue(values: Array<string | null | undefined> | null | undefined) {
  return (values ?? []).some((value) => isTenantDeviceLabelValue(value));
}
