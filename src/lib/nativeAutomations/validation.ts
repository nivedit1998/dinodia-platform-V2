import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { automationSources, type AutomationSource } from './triggerReferences';

export class NativeAutomationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type ActionInput = { deviceId: string; areaId: string; controlId: string; targetValue: Record<string, unknown> };
type NormalizedDefinition = { triggerKind: 'SCHEDULE' | 'DEVICE_STATE'; triggerConfiguration: Record<string, unknown>; name: string; minuteOfDay: number; weekdays: number[]; initiallyEnabled: boolean; actions: Array<ActionInput & { sortOrder: number; descriptorRevision: number; managementClass: string; osDeviceId: string; osAreaId: string }> };
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
  homeId: string; membershipId: string; grantedAreaIds: readonly string[]; raw: unknown; allowInitialState?: boolean; contractVersion?: number;
}): Promise<NormalizedDefinition> {
  const allowedKeys = input.allowInitialState ? ['name', 'trigger', 'actions', 'enabled'] : ['name', 'trigger', 'actions'];
  if (!plainObject(input.raw) || Object.keys(input.raw).some((key) => !allowedKeys.includes(key))) fail('AUTOMATION_INVALID', 'The automation details are incomplete');
  if (input.allowInitialState && input.raw.enabled !== undefined && typeof input.raw.enabled !== 'boolean') fail('AUTOMATION_INVALID', 'The automation enabled state is not valid');
  if (!validName(input.raw.name)) fail('AUTOMATION_INVALID', 'The automation name must be 1–60 characters');
  if (!plainObject(input.raw.trigger)) fail('AUTOMATION_TRIGGER_INVALID', 'Choose when this automation should run');
  const custom = input.raw.trigger.kind === 'device_state';
  let configuration: Record<string, unknown>;
  let selectedHubId: string | null = null;
  let minuteOfDay = 0;
  let weekdays: number[] = [];
  if (custom) {
    if (input.contractVersion !== 2) fail('AUTOMATION_UPGRADE_REQUIRED', 'Update the app to edit custom triggers', 409);
    const selectedHome = await tx.home.findUnique({where:{id:input.homeId},select:{activeHubInstallationId:true}});
    selectedHubId = selectedHome?.activeHubInstallationId ?? null;
    if (!selectedHubId) fail('AUTOMATION_HUB_UPDATE_REQUIRED','Your current Home hub is unavailable',409);
    const hub = await tx.hubInstallation.findFirst({ where: { id:selectedHubId, homeId: input.homeId, lifecycleStatus: 'ACTIVE' }, select: { capabilitySummary: true } });
    if (!plainObject(hub?.capabilitySummary) || hub.capabilitySummary.nativeDeviceTriggersV2 !== true) fail('AUTOMATION_HUB_UPDATE_REQUIRED', 'Update your Home hub before creating custom triggers', 409);
    configuration = await validateDeviceTrigger(tx, {...input,hubInstallationId:selectedHubId}, input.raw.trigger);
  } else {
    if (Object.keys(input.raw.trigger).some(key => !['minuteOfDay','weekdays'].includes(key))) fail('AUTOMATION_TRIGGER_INVALID','Choose one recurring time and weekdays');
    if (!Number.isSafeInteger(input.raw.trigger.minuteOfDay) || Number(input.raw.trigger.minuteOfDay) < 0 || Number(input.raw.trigger.minuteOfDay) > 1439
      || !Array.isArray(input.raw.trigger.weekdays) || input.raw.trigger.weekdays.length < 1 || input.raw.trigger.weekdays.length > 7
      || input.raw.trigger.weekdays.some((day) => !Number.isSafeInteger(day) || Number(day) < 1 || Number(day) > 7)
      || new Set(input.raw.trigger.weekdays).size !== input.raw.trigger.weekdays.length) fail('AUTOMATION_TRIGGER_INVALID', 'Choose one valid local time and at least one weekday');
    minuteOfDay = Number(input.raw.trigger.minuteOfDay);
    weekdays = input.raw.trigger.weekdays as number[];
    configuration = { minuteOfDay, weekdays: [...weekdays].sort((a,b) => a-b) };
  }
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
      id: action.deviceId, homeId: input.homeId, lifecycle: 'INSTALLED', ...(custom ? {hubInstallationId:selectedHubId!}:{}),
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
    if (custom && control.idempotency !== 'set_value') fail('AUTOMATION_CONTROL_UNAVAILABLE','Custom triggers require safe absolute actions');
    if (control.writable !== true || control.automatable !== true || !['set_value', 'invoke_once'].includes(String(control.idempotency)) || !targetMatches(control, action.targetValue)) {
      fail('AUTOMATION_CONTROL_UNAVAILABLE', 'This control or value cannot be used in an automation');
    }
    actions.push({ ...action, sortOrder, descriptorRevision: device.descriptorRevision, managementClass: device.managementClass,
      osDeviceId: device.osDeviceId, osAreaId: device.assignments[0].area.osAreaId });
  }
  if (custom && automationSources(configuration).some(source => actions.some(action => action.deviceId === source.deviceId && action.controlId === source.controlId))) fail('AUTOMATION_FEEDBACK_LOOP', 'Choose an action different from the trigger and condition readings');
  return { triggerKind: custom ? 'DEVICE_STATE' : 'SCHEDULE', triggerConfiguration: configuration, name: input.raw.name.normalize('NFC').trim(), minuteOfDay: Number(minuteOfDay), weekdays: [...weekdays as number[]].sort((a, b) => a - b),
    initiallyEnabled: input.allowInitialState ? input.raw.enabled !== false : true, actions };
}

export async function assertNoNativeAutomationConflict(tx: Prisma.TransactionClient, input: {
  homeId: string; candidate: NormalizedDefinition; excludeAutomationId?: string;
}) {
  if (input.candidate.triggerKind === 'DEVICE_STATE') return;
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


async function validateDeviceTrigger(tx: Prisma.TransactionClient, authority: { homeId: string; membershipId: string; grantedAreaIds: readonly string[]; hubInstallationId:string }, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = ['kind','deviceId','areaId','controlId','operator','value','resetMargin','conditions'];
  if (Object.keys(raw).some(k => !keys.includes(k)) || !['becomes','rises_above','falls_below'].includes(String(raw.operator))) fail('AUTOMATION_TRIGGER_INVALID', 'Choose a supported device change');
  const resolve = async (r: Record<string, unknown>): Promise<{ source: AutomationSource; control: Record<string, unknown> }> => {
    if (!UUID.test(String(r.deviceId)) || !UUID.test(String(r.areaId)) || !authority.grantedAreaIds.includes(String(r.areaId)) || typeof r.controlId !== 'string') fail('AUTOMATION_SCOPE_DENIED', 'This reading is not available in your rooms',403);
    const device = await tx.nativeDevice.findFirst({ where: { id: String(r.deviceId), homeId: authority.homeId, hubInstallationId:authority.hubInstallationId, lifecycle: 'INSTALLED',
      assignments: { some: { homeId: authority.homeId, areaId: String(r.areaId), validUntil: null, area: { status: 'ACTIVE' } } },
      OR: [{ managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null }, { managementClass: 'TENANT_DEVICE', ownerMembershipId: authority.membershipId }] },
      select: { id:true,osDeviceId:true,managementClass:true,ownerMembershipId:true,descriptorRevision:true,capabilitySummary:true,assignments:{where:{areaId:String(r.areaId),validUntil:null},take:1,select:{area:{select:{osAreaId:true}}}} } });
    const catalog = plainObject(device?.capabilitySummary) && plainObject(device.capabilitySummary.controlCatalog) ? device.capabilitySummary.controlCatalog : {};
    const control = Array.isArray(catalog.controls) ? catalog.controls.find((c: unknown) => plainObject(c) && c.controlId === r.controlId) as Record<string, unknown> | undefined : undefined;
    if (!device || !control || control.readable !== true || control.observable !== true || !['boolean','number','option'].includes(String(control.valueType)) || control.stepUpPolicy === 'required' || ['sensitive','critical'].includes(String(control.riskLevel)) || APP_ONLY_ROLES.has(String(control.semanticRole))) fail('AUTOMATION_SOURCE_UNAVAILABLE', 'This reading cannot be used in an automation');
    if (Number(catalog.revision) !== device.descriptorRevision || Number(control.catalogRevision) !== device.descriptorRevision || !device.assignments[0]) fail('AUTOMATION_DESCRIPTOR_STALE', 'This device changed. Refresh and choose its reading again',409);
    return { source: {deviceId:device.id,areaId:String(r.areaId),controlId:String(r.controlId),osDeviceId:device.osDeviceId,osAreaId:device.assignments[0].area.osAreaId,descriptorRevision:device.descriptorRevision,managementClass:device.managementClass,ownerMembershipId:device.ownerMembershipId}, control };
  };
  const checkValue = (control: Record<string, unknown>, value: unknown) => {
    // A sensor threshold is not a writable setpoint: retain type/range/options,
    // but do not force it onto the actuator's step grid.
    const constraints = plainObject(control.constraints) ? {...control.constraints} : {};
    delete constraints.step;
    if (!targetMatches({...control,constraints},value)) fail('AUTOMATION_TRIGGER_INVALID','Choose a valid reading value');
  };
  const { source, control } = await resolve(raw);
  checkValue(control,raw.value);
  if (raw.operator !== 'becomes' && control.valueType !== 'number' || raw.operator === 'becomes' && control.valueType === 'number') fail('AUTOMATION_TRIGGER_INVALID','Choose a change supported by this reading');
  const margin = raw.resetMargin ?? 0;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 1000000) fail('AUTOMATION_TRIGGER_INVALID','The reset margin is invalid');
  const group = raw.conditions ?? {mode:'all',items:[]};
  if (!plainObject(group) || Object.keys(group).some(k=>!['mode','items'].includes(k)) || !['all','any'].includes(String(group.mode)) || !Array.isArray(group.items) || group.items.length>8) fail('AUTOMATION_CONDITIONS_INVALID','Choose up to eight conditions');
  const items: Record<string, unknown>[] = [];
  for (const item of group.items) {
    if (!plainObject(item)) fail('AUTOMATION_CONDITIONS_INVALID','A condition is invalid');
    if (item.kind === 'time_window') {
      if (Object.keys(item).some(k=>!['kind','startMinute','endMinute','weekdays'].includes(k)) || !Number.isSafeInteger(item.startMinute) || Number(item.startMinute)<0 || Number(item.startMinute)>1439 || !Number.isSafeInteger(item.endMinute) || Number(item.endMinute)<0 || Number(item.endMinute)>1439 || item.startMinute===item.endMinute || !Array.isArray(item.weekdays) || !item.weekdays.length || item.weekdays.length>7 || item.weekdays.some(d=>!Number.isSafeInteger(d)||d<1||d>7) || new Set(item.weekdays).size!==item.weekdays.length) fail('AUTOMATION_CONDITIONS_INVALID','Choose a valid time window and days');
      items.push(item); continue;
    }
    if (item.kind !== 'device_state' || Object.keys(item).some(k=>!['kind','deviceId','areaId','controlId','operator','value','upperValue'].includes(k)) || !['equals','not_equals','above','below','between'].includes(String(item.operator))) fail('AUTOMATION_CONDITIONS_INVALID','Choose a supported condition');
    const resolved=await resolve(item);checkValue(resolved.control,item.value);
    if (['above','below','between'].includes(String(item.operator)) && resolved.control.valueType!=='number') fail('AUTOMATION_CONDITIONS_INVALID','This condition requires a numeric reading');
    if (item.operator==='between') {checkValue(resolved.control,item.upperValue);if(Number((item.value as Record<string,unknown>).number)>=Number((item.upperValue as Record<string,unknown>).number)) fail('AUTOMATION_CONDITIONS_INVALID','Choose an increasing range');}
    else if (item.upperValue!==undefined) fail('AUTOMATION_CONDITIONS_INVALID','Unexpected upper value');
    items.push({kind:'device_state',source:resolved.source,operator:item.operator,value:item.value,...(item.upperValue?{upperValue:item.upperValue}:{})});
  }
  return {kind:'device_state',source,operator:raw.operator,value:raw.value,resetMargin:margin,cooldownSeconds:30,conditions:{mode:group.mode,items}};
}
