import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export class NativeAutomationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type ActionInput = { deviceId: string; areaId: string; controlId: string; targetValue: Record<string, unknown> };
type NormalizedDefinition = { name: string; minuteOfDay: number; weekdays: number[]; actions: Array<ActionInput & { sortOrder: number; descriptorRevision: number; managementClass: string; osDeviceId: string; osAreaId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ONLY_ROLES = new Set(['security_lock', 'lock_state']);

function fail(code: string, message: string, status = 400): never { throw new NativeAutomationError(status, code, message); }
function plainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validName(value: unknown): value is string {
  return typeof value === 'string' && [...value.normalize('NFC').trim()].length > 0 && [...value.normalize('NFC').trim()].length <= 60 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plainObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function targetMatches(control: Record<string, unknown>, value: unknown): boolean {
  if (!plainObject(value) || !['type', 'boolean', 'number', 'option', 'text'].includes(String(value.type))) return false;
  const constraints = plainObject(control.constraints) ? control.constraints : {};
  switch (control.valueType) {
    case 'boolean': return value.type === 'boolean' && typeof value.boolean === 'boolean';
    case 'number': {
      if (value.type !== 'number' || typeof value.number !== 'number' || !Number.isFinite(value.number)) return false;
      if (typeof constraints.minimum === 'number' && value.number < constraints.minimum) return false;
      if (typeof constraints.maximum === 'number' && value.number > constraints.maximum) return false;
      if (typeof constraints.step === 'number' && constraints.step > 0 && typeof constraints.minimum === 'number') {
        const steps = (value.number - constraints.minimum) / constraints.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-7) return false;
      }
      return true;
    }
    case 'option': return value.type === 'option' && typeof value.option === 'string' && [...value.option].length <= 128
      && Array.isArray(constraints.options) && constraints.options.includes(value.option);
    case 'text': return value.type === 'text' && typeof value.text === 'string' && [...value.text].length <= 128
      && !/[\u0000-\u001f\u007f]/u.test(value.text);
    default: return false;
  }
}

function scheduleOverlaps(left: { minuteOfDay: number; weekdays: number[] }, right: { minuteOfDay: number; weekdays: number[] }): boolean {
  return left.minuteOfDay === right.minuteOfDay && left.weekdays.some((day) => right.weekdays.includes(day));
}

export async function validateNativeAutomationDefinition(tx: Prisma.TransactionClient, input: {
  homeId: string; membershipId: string; grantedAreaIds: readonly string[]; raw: unknown;
}): Promise<NormalizedDefinition> {
  if (!plainObject(input.raw) || Object.keys(input.raw).some((key) => !['name', 'trigger', 'actions'].includes(key))) fail('AUTOMATION_INVALID', 'The automation details are incomplete');
  if (!validName(input.raw.name)) fail('AUTOMATION_INVALID', 'The automation name must be 1–60 characters');
  if (!plainObject(input.raw.trigger) || Object.keys(input.raw.trigger).some((key) => !['minuteOfDay', 'weekdays'].includes(key))) fail('AUTOMATION_TRIGGER_INVALID', 'Choose one recurring time and weekdays');
  const minuteOfDay = input.raw.trigger.minuteOfDay;
  const weekdays = input.raw.trigger.weekdays;
  if (!Number.isSafeInteger(minuteOfDay) || Number(minuteOfDay) < 0 || Number(minuteOfDay) > 1439
    || !Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7
    || weekdays.some((day) => !Number.isSafeInteger(day) || Number(day) < 1 || Number(day) > 7)
    || new Set(weekdays).size !== weekdays.length) fail('AUTOMATION_TRIGGER_INVALID', 'Choose one valid local time and at least one weekday');
  if (!Array.isArray(input.raw.actions) || input.raw.actions.length < 1 || input.raw.actions.length > 32) fail('AUTOMATION_ACTIONS_INVALID', 'Add between one and 32 device actions');

  const actions: NormalizedDefinition['actions'] = [];
  const uniqueTargets = new Set<string>();
  for (const [sortOrder, rawAction] of input.raw.actions.entries()) {
    if (!plainObject(rawAction) || Object.keys(rawAction).some((key) => !['deviceId', 'areaId', 'controlId', 'targetValue'].includes(key))) fail('AUTOMATION_ACTION_INVALID', 'An automation action is not valid');
    const action = rawAction as unknown as ActionInput;
    if (!UUID.test(String(action.deviceId)) || !UUID.test(String(action.areaId)) || typeof action.controlId !== 'string' || action.controlId.length < 1 || action.controlId.length > 160) fail('AUTOMATION_ACTION_INVALID', 'An automation target is not valid');
    if (!input.grantedAreaIds.includes(action.areaId)) fail('AUTOMATION_SCOPE_DENIED', 'This device is not available in the selected Home');
    const uniqueTarget = `${action.deviceId}:${action.controlId}`;
    if (uniqueTargets.has(uniqueTarget)) fail('AUTOMATION_ACTION_DUPLICATE', 'Choose each device control only once');
    uniqueTargets.add(uniqueTarget);
    const device = await tx.nativeDevice.findFirst({ where: {
      id: action.deviceId, homeId: input.homeId, lifecycle: 'INSTALLED',
      assignments: { some: { homeId: input.homeId, areaId: action.areaId, validUntil: null, area: { status: 'ACTIVE' } } },
      OR: [
        { managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null },
        { managementClass: 'TENANT_DEVICE', ownerMembershipId: input.membershipId },
      ],
    }, select: { id: true, osDeviceId: true, managementClass: true, ownerMembershipId: true, descriptorRevision: true, capabilitySummary: true, assignments: { where: { areaId: action.areaId, validUntil: null }, select: { area: { select: { osAreaId: true } } }, take: 1 } } });
    if (!device || device.managementClass === 'TENANT_DEVICE' && device.ownerMembershipId !== input.membershipId) fail('AUTOMATION_SCOPE_DENIED', 'This device is not available in the selected Home');
    const summary = plainObject(device.capabilitySummary) ? device.capabilitySummary : {};
    const catalog = plainObject(summary.controlCatalog) ? summary.controlCatalog : {};
    const controls: Record<string, unknown>[] = Array.isArray(catalog.controls)
      ? catalog.controls.filter((item) => plainObject(item)).map((item) => item as unknown as Record<string, unknown>) : [];
    const control = controls.find((item) => item.controlId === action.controlId);
    if (!control || Number(catalog.revision) !== device.descriptorRevision || Number(control.catalogRevision) !== device.descriptorRevision) fail('AUTOMATION_DESCRIPTOR_STALE', 'This device’s controls have changed. Refresh and try again', 409);
    if (APP_ONLY_ROLES.has(String(control.semanticRole)) || control.stepUpPolicy === 'required' || ['sensitive', 'critical'].includes(String(control.riskLevel))) {
      fail('AUTOMATION_CONTROL_APP_ONLY', 'This safety control needs an interactive action and cannot run on a schedule');
    }
    if (control.writable !== true || control.automatable !== true || !['set_value', 'invoke_once'].includes(String(control.idempotency)) || !targetMatches(control, action.targetValue)) {
      fail('AUTOMATION_CONTROL_UNAVAILABLE', 'This control or value cannot be used in an automation');
    }
    actions.push({ ...action, sortOrder, descriptorRevision: device.descriptorRevision, managementClass: device.managementClass,
      osDeviceId: device.osDeviceId, osAreaId: device.assignments[0].area.osAreaId });
  }
  return { name: input.raw.name.normalize('NFC').trim(), minuteOfDay: Number(minuteOfDay), weekdays: [...weekdays as number[]].sort((a, b) => a - b), actions };
}

export async function assertNoNativeAutomationConflict(tx: Prisma.TransactionClient, input: {
  homeId: string; candidate: NormalizedDefinition; excludeAutomationId?: string;
}) {
  const existing = await tx.nativeAutomation.findMany({ where: { homeId: input.homeId, status: 'ACTIVE', ...(input.excludeAutomationId ? { id: { not: input.excludeAutomationId } } : {}) }, select: {
    id: true, timezone: true, triggers: { select: { configuration: true }, take: 1 }, actions: { select: { deviceId: true, controlId: true, actionValue: true, device: { select: { capabilitySummary: true } } } },
  } });
  const candidateTrigger = { minuteOfDay: input.candidate.minuteOfDay, weekdays: input.candidate.weekdays };
  for (const rule of existing) {
    const trigger = rule.triggers[0]?.configuration;
    if (!plainObject(trigger) || !scheduleOverlaps(candidateTrigger, { minuteOfDay: Number(trigger.minuteOfDay), weekdays: Array.isArray(trigger.weekdays) ? trigger.weekdays.filter((day): day is number => Number.isInteger(day)) : [] })) continue;
    for (const proposed of input.candidate.actions) {
      const same = rule.actions.find((action) => action.deviceId === proposed.deviceId && action.controlId === proposed.controlId);
      if (!same) continue;
      const controlSummary = plainObject(same.device.capabilitySummary) && plainObject(same.device.capabilitySummary.controlCatalog) ? same.device.capabilitySummary.controlCatalog : {};
      const controls: Record<string, unknown>[] = Array.isArray(controlSummary.controls)
        ? controlSummary.controls.filter((item) => plainObject(item)).map((item) => item as unknown as Record<string, unknown>) : [];
      const descriptor = controls.find((item) => item.controlId === proposed.controlId);
      const compatible = descriptor?.idempotency === 'set_value' && plainObject(descriptor.constraints) && descriptor.constraints.mutuallyExclusive !== true
        && canonical(same.actionValue) === canonical(proposed.targetValue);
      if (!compatible) fail('AUTOMATION_CONFLICT', 'This schedule conflicts with another active automation on a device control', 409);
    }
  }
}

export function automationDefinitionChecksum(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
