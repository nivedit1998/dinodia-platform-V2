/** All device/Area references, including read-only trigger and condition sources. */
export type AutomationSource = { deviceId: string; areaId: string; controlId: string; osDeviceId: string; osAreaId: string; descriptorRevision: number; managementClass: string; ownerMembershipId: string | null };
export function automationSources(configuration: unknown): AutomationSource[] {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return [];
  const c = configuration as Record<string, unknown>;
  if (c.kind !== 'device_state') return [];
  const conditions = c.conditions as { items?: Array<{ kind?: string; source?: AutomationSource }> } | undefined;
  return [c.source as AutomationSource, ...(conditions?.items ?? []).filter(x => x.kind === 'device_state').map(x => x.source!)]
    .filter((x): x is AutomationSource => !!x && typeof x.deviceId === 'string' && typeof x.areaId === 'string');
}
export function automationContractVersion(request: Request): number {
  const value = request.headers.get('x-dinodia-automations');
  if (value && value !== '2') throw Object.assign(new Error('Unsupported automation contract'), { status: 406, code: 'AUTOMATION_CONTRACT_UNSUPPORTED' });
  return value === '2' ? 2 : 1;
}
export function sourceConfigurationForClient(configuration: unknown): unknown {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  const c = configuration as Record<string, unknown>;
  const source = (x: unknown) => { const r = x as AutomationSource; return { deviceId: r.deviceId, areaId: r.areaId, controlId: r.controlId }; };
  if (c.kind !== 'device_state' || !c.source) return null;
  const group = c.conditions as { mode: string; items: Array<Record<string, unknown>> };
  return { kind: 'device_state', ...source(c.source), operator: c.operator, value: c.value, resetMargin: c.resetMargin,
    conditions: { mode: group.mode, items: group.items.map(x => x.kind === 'device_state'
      ? { kind: 'device_state', ...source(x.source), operator: x.operator, value: x.value, ...(x.upperValue ? { upperValue: x.upperValue } : {}) }
      : x) } };
}
