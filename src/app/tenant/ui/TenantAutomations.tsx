// Architecture: App Router surface src/app/tenant/ui/TenantAutomations.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import type { UIDevice } from '@/types/device';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { fetchTenantInventorySnapshot } from '@/lib/tenantInventoryClient';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { summarizeAutomation } from '@/lib/automationSummaries';
import {
  DeviceActionSpec,
  DeviceServiceSpec,
  DeviceTriggerSpec,
  getTenantDashboardDevices,
  getPrimaryAutomationActions,
  getAdvancedAutomationServices,
  getDashboardLevelTriggers,
} from '@/lib/deviceCapabilities';

type AutomationListItem = {
  id: string;
  entityId?: string;
  alias: string;
  description: string;
  mode: string;
  entities: string[];
  actionDeviceIds?: string[];
  hasTemplates: boolean;
  canEdit: boolean;
  enabled?: boolean;
  basicSummary?: string;
  triggerSummary?: string;
  actionSummary?: string;
  primaryName?: string;
  raw?: {
    triggers?: unknown[];
    trigger?: unknown[];
    conditions?: unknown[];
    condition?: unknown[];
    actions?: unknown[];
    action?: unknown[];
    [key: string]: unknown;
  };
};

type CreateFormState = {
  alias: string;
  description: string;
  anyTime: boolean;
  triggerEntityId: string;
  triggerMode: 'state_equals' | 'attribute_delta' | 'position_equals';
  triggerTo: string | number | '';
  triggerDirection: 'increased' | 'decreased' | '';
  triggerAttribute: string | '';
  scheduleAt: string;
  scheduleWeekdays: string[];
  actionEntityId: string;
  actionKind: 'device_command' | 'ha_service';
  actionCommand: string;
  actionValue: string | number | '';
  actionServiceId: string;
  actionServiceValue: string | number | '';
  enabled: boolean;
};

const weekdayOptions = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
];

const defaultFormState: CreateFormState = {
  alias: '',
  description: '',
  anyTime: true,
  triggerEntityId: '',
  triggerMode: 'state_equals',
  triggerTo: '',
  triggerDirection: '',
  triggerAttribute: '',
  scheduleAt: '',
  scheduleWeekdays: weekdayOptions.map((d) => d.value),
  actionEntityId: '',
  actionKind: 'device_command',
  actionCommand: '',
  actionValue: '',
  actionServiceId: '',
  actionServiceValue: '',
  enabled: true,
};

type DeviceOptions = {
  actionDevices: { value: string; label: string }[];
  triggerDevices: { value: string; label: string }[];
};

function buildNameCounts(devices: UIDevice[]) {
  const counts = new Map<string, number>();
  devices.forEach((d) => {
    const key = (d.displayName ?? d.name ?? '').trim();
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function buildLabel(d: UIDevice, nameCounts: Map<string, number>) {
  const base = (d.displayName ?? d.name ?? '').trim() || d.entityId;
  const dupCount = nameCounts.get(base) ?? 0;
  if (dupCount <= 1) return base;
  const areaName = (d.displayAreaName ?? d.areaName ?? d.area ?? '').trim();
  return areaName ? `${base} (${areaName})` : base;
}

function buildDeviceOptions(devices: UIDevice[]): DeviceOptions {
  const dashboardDevices = getTenantDashboardDevices(devices);
  const nameCounts = buildNameCounts(dashboardDevices);

  const actionDevices = dashboardDevices
    .filter((d) => {
      const primary = getPrimaryAutomationActions(d).length > 0;
      const advanced = getAdvancedAutomationServices(d).length > 0;
      return primary || advanced;
    })
    .map((d) => ({ value: d.entityId, label: buildLabel(d, nameCounts) }));

  const triggerDevices = dashboardDevices
    .filter((d) => getDashboardLevelTriggers(d).length > 0)
    .map((d) => ({ value: d.entityId, label: buildLabel(d, nameCounts) }));

  return { actionDevices, triggerDevices };
}

function renderActionInput(
  spec: DeviceActionSpec | null,
  value: string | number | '',
  onChange: (v: string | number | '') => void
) {
  if (!spec) return null;
  switch (spec.kind) {
    case 'command':
      return <p className="text-sm text-slate-500">No additional input required.</p>;
    case 'slider':
      return (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            value={typeof value === 'number' ? value : spec.min}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1 accent-indigo-600"
          />
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            value={value}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      );
    case 'fixed-position':
      return (
        <select
          value={value === '' ? '' : value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Select position</option>
          {spec.positions.map((pos) => (
            <option key={pos.value} value={pos.value}>
              {pos.label}
            </option>
          ))}
        </select>
      );
    default:
      return null;
  }
}

function renderServiceInput(
  spec: DeviceServiceSpec | null,
  value: string | number | '',
  onChange: (v: string | number | '') => void
) {
  if (!spec) return null;
  if (spec.uiKind === 'button') {
    return <p className="text-sm text-slate-500">No additional input required.</p>;
  }
  if (spec.uiKind === 'slider' && spec.sliderSpec) {
    const numeric = typeof value === 'number' ? value : spec.sliderSpec.min;
    return (
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={spec.sliderSpec.min}
          max={spec.sliderSpec.max}
          step={spec.sliderSpec.step}
          value={numeric}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-indigo-600"
        />
        <input
          type="number"
          min={spec.sliderSpec.min}
          max={spec.sliderSpec.max}
          step={spec.sliderSpec.step}
          value={numeric}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
    );
  }
  if (spec.uiKind === 'select' && spec.selectSpec) {
    return (
      <select
        value={typeof value === 'string' ? value : spec.selectSpec.options[0] ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {(spec.selectSpec.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    );
  }
  return null;
}

function renderTriggerInput(
  spec: DeviceTriggerSpec | null,
  form: CreateFormState,
  onChange: (updates: Partial<CreateFormState>) => void
) {
  if (!spec) return <p className="text-sm text-slate-500">No triggers available for this device.</p>;

  switch (spec.type) {
    case 'state_equals':
      return (
        <select
          value={form.triggerTo}
          onChange={(e) => onChange({ triggerTo: e.target.value })}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Select state</option>
          {spec.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'attribute_delta':
      return (
        <select
          value={form.triggerDirection}
          onChange={(e) =>
            onChange({
              triggerDirection: e.target.value as CreateFormState['triggerDirection'],
              triggerAttribute: spec.attributes[0] ?? '',
            })
          }
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Select change</option>
          {spec.directionOptions.map((dir) => (
            <option key={dir} value={dir}>
              {dir === 'increased' ? 'Increased' : 'Decreased'}
            </option>
          ))}
        </select>
      );
    case 'position_equals':
      return (
        <select
          value={form.triggerTo}
          onChange={(e) =>
            onChange({
              triggerTo: Number(e.target.value),
              triggerAttribute: spec.attributes[0] ?? '',
            })
          }
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Select position</option>
          {spec.values.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      );
    default:
      return null;
  }
}

export default function TenantAutomations() {
  const { pushToast } = useToast();
  const [automations, setAutomations] = useState<AutomationListItem[]>([]);
  const [loadingAutomations, setLoadingAutomations] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [devices, setDevices] = useState<UIDevice[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [form, setForm] = useState<CreateFormState>({ ...defaultFormState });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [automationToDelete, setAutomationToDelete] = useState<AutomationListItem | null>(null);

  const actionDevice = devices.find((d) => d.entityId === form.actionEntityId);
  const triggerDevice = devices.find((d) => d.entityId === form.triggerEntityId);

  const deviceOptions = useMemo(() => buildDeviceOptions(devices), [devices]);

  const triggerSpecs = useMemo(
    () => (triggerDevice ? getDashboardLevelTriggers(triggerDevice) : []),
    [triggerDevice]
  );
  const primaryActionSpecs = useMemo(
    () => (actionDevice ? getPrimaryAutomationActions(actionDevice) : []),
    [actionDevice]
  );
  const advancedServiceSpecs = useMemo(
    () => (actionDevice ? getAdvancedAutomationServices(actionDevice) : []),
    [actionDevice]
  );

  async function fetchAndSetAutomations(entityId?: string) {
    setLoadingAutomations(true);
    try {
      const url = entityId ? `/api/automations?entityId=${encodeURIComponent(entityId)}` : '/api/automations';
      const data = await platformFetchJson<{ automations?: AutomationListItem[] }>(
        url,
        { credentials: 'include' },
        'Unsuccessful - we could not load automations right now.'
      );
      const list: AutomationListItem[] = Array.isArray(data.automations)
        ? data.automations
        : [];
      setAutomations(list);
    } catch (err) {
      setError(friendlyUnknownError(err, 'Unsuccessful - we could not load automations right now.'));
    } finally {
      setLoadingAutomations(false);
    }
  }

  useEffect(() => {
    void fetchAndSetAutomations(selectedEntityId);
  }, [selectedEntityId]);

  useEffect(() => {
    async function loadDevices() {
      setLoadingDevices(true);
      try {
        const snapshot = await fetchTenantInventorySnapshot({ preferWarm: true });
        const list: UIDevice[] = Array.isArray(snapshot.devices) ? snapshot.devices : [];
        setDevices(list);
      } catch (err) {
        setError(friendlyUnknownError(err, 'Unsuccessful - we could not load devices right now.'));
      } finally {
        setLoadingDevices(false);
      }
    }
    void loadDevices();
  }, []);

  function resetActionFields(specs: DeviceActionSpec[]) {
    const first = specs[0];
    if (!first) {
      setForm((prev) => ({ ...prev, actionKind: 'device_command', actionCommand: '', actionValue: '' }));
      return;
    }
    setForm((prev) => ({ ...prev, actionKind: 'device_command' }));
    if (first.kind === 'slider') {
      setForm((prev) => ({
        ...prev,
        actionCommand: first.id,
        actionValue: first.min,
      }));
    } else if (first.kind === 'fixed-position') {
      const val = first.positions[0]?.value ?? '';
      setForm((prev) => ({
        ...prev,
        actionCommand: first.id,
        actionValue: val,
      }));
    } else if (first.kind === 'command') {
      setForm((prev) => ({ ...prev, actionCommand: first.id, actionValue: '' }));
    }
  }

  function resetServiceFields(services: DeviceServiceSpec[]) {
    const first = services[0];
    if (!first) {
      setForm((prev) => ({ ...prev, actionServiceId: '', actionServiceValue: '' }));
      return;
    }
    if (first.uiKind === 'slider' && first.sliderSpec) {
      const sliderSpec = first.sliderSpec;
      setForm((prev) => ({
        ...prev,
        actionServiceId: first.serviceId,
        actionServiceValue: sliderSpec.min,
      }));
      return;
    }
    if (first.uiKind === 'select' && first.selectSpec) {
      const selectSpec = first.selectSpec;
      setForm((prev) => ({
        ...prev,
        actionServiceId: first.serviceId,
        actionServiceValue: selectSpec.options[0] ?? '',
      }));
      return;
    }
    setForm((prev) => ({ ...prev, actionServiceId: first.serviceId, actionServiceValue: '' }));
  }

  function resetTriggerFields(specs: DeviceTriggerSpec[]) {
    const first = specs[0];
    if (!first) {
      setForm((prev) => ({
        ...prev,
        triggerMode: 'state_equals',
        triggerTo: '',
        triggerDirection: '',
        triggerAttribute: '',
      }));
      return;
    }
    setForm((prev) => ({
      ...prev,
      triggerMode: first.type,
      triggerTo: first.type === 'position_equals' ? first.values[0]?.value ?? '' : '',
      triggerDirection: first.type === 'attribute_delta' ? first.directionOptions[0] ?? '' : '',
      triggerAttribute:
        first.type === 'attribute_delta'
          ? first.attributes[0] ?? ''
          : first.type === 'position_equals'
          ? first.attributes[0] ?? ''
          : '',
    }));
  }

  function updateForm<K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload() {
    if (!form.alias.trim()) throw new Error('Name is required');
    if (form.anyTime) {
      if (!form.triggerEntityId) throw new Error('Trigger entity is required');
      if (form.triggerMode === 'state_equals' && form.triggerTo === '') {
        throw new Error('Trigger state is required');
      }
      if (form.triggerMode === 'attribute_delta' && !form.triggerDirection) {
        throw new Error('Select increased or decreased');
      }
      if (form.triggerMode === 'position_equals' && form.triggerTo === '') {
        throw new Error('Trigger position is required');
      }
    } else {
      if (!form.scheduleAt) throw new Error('Schedule time is required');
    }
    if (!form.actionEntityId) throw new Error('Action entity is required');
    if (form.actionKind === 'device_command' && !form.actionCommand) throw new Error('Choose an action');
    if (form.actionKind === 'ha_service' && !form.actionServiceId) throw new Error('Choose an advanced action');

    const payload: Record<string, unknown> = {
      alias: form.alias.trim(),
      description: form.description.trim(),
      mode: 'single',
      enabled: form.enabled,
    };

    if (form.anyTime) {
      payload.trigger = {
        type: 'device',
        entityId: form.triggerEntityId,
        mode: form.triggerMode,
        to: form.triggerTo,
        direction: form.triggerDirection || undefined,
        attribute: form.triggerAttribute || undefined,
        weekdays: form.scheduleWeekdays,
      };
    } else {
      payload.trigger = {
        type: 'schedule',
        scheduleType: 'weekly',
        at: form.scheduleAt,
        weekdays: form.scheduleWeekdays,
      };
    }

    if (form.actionKind === 'device_command') {
      payload.action = {
        type: 'device_command',
        entityId: form.actionEntityId,
        command: form.actionCommand,
        value: form.actionValue === '' ? undefined : form.actionValue,
      };
    } else {
      const selectedService =
        advancedServiceSpecs.find((s) => s.serviceId === form.actionServiceId) ?? null;
      if (!selectedService) throw new Error('Choose an advanced action');
      let serviceData: Record<string, unknown> = {};
      if (selectedService.uiKind === 'slider' && selectedService.sliderSpec) {
        serviceData = { [selectedService.sliderSpec.key]: Number(form.actionServiceValue) };
      } else if (selectedService.uiKind === 'select' && selectedService.selectSpec) {
        serviceData = {
          [selectedService.selectSpec.key]:
            typeof form.actionServiceValue === 'string'
              ? form.actionServiceValue
              : selectedService.selectSpec.options[0] ?? '',
        };
      }
      payload.action = {
        type: 'ha_service',
        entityId: form.actionEntityId,
        serviceId: selectedService.serviceId,
        serviceData,
      };
    }

    return payload;
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      await platformFetchJson<{ ok: boolean }>(
        '/api/automations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include',
        },
        'Unsuccessful - we could not save this automation.'
      );
      setForm({ ...defaultFormState });
      await fetchAndSetAutomations(selectedEntityId);
      pushToast({
        kind: 'success',
        title: 'Automation saved',
        message: 'Done - everything looks good.',
      });
    } catch (err) {
      setError(friendlyUnknownError(err, 'Unsuccessful - we could not save this automation.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      await platformFetchJson<{ ok: boolean }>(
        `/api/automations/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          credentials: 'include',
        },
        'Unsuccessful - we could not remove this automation.'
      );
      await fetchAndSetAutomations(selectedEntityId);
      pushToast({
        kind: 'success',
        title: 'Automation removed',
        message: 'Your home rules are up to date.',
      });
    } catch (err) {
      setError(friendlyUnknownError(err, 'Unsuccessful - we could not remove this automation.'));
    } finally {
      setDeletingId(null);
      setAutomationToDelete(null);
    }
  }

  useEffect(() => {
    resetTriggerFields(triggerSpecs);
  }, [form.triggerEntityId, triggerSpecs]);

  useEffect(() => {
    resetActionFields(primaryActionSpecs);
    resetServiceFields(advancedServiceSpecs);
  }, [form.actionEntityId, primaryActionSpecs, advancedServiceSpecs]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold leading-tight text-slate-900">Home Automations</h1>
        <p className="text-sm text-slate-500">
          You only see Dinodia-managed automations for devices in your assigned areas.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm space-y-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">View automations</h2>
              <p className="text-xs text-slate-500">
                Choose a device to see automations whose <strong>actions</strong> target it.
              </p>
            </div>
            <Link
              href="/tenant/dashboard"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
            >
              Back to dashboard
            </Link>
          </div>
          <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <label className="text-xs font-medium text-slate-600">Device / Entity</label>
                <select
                  value={selectedEntityId}
                  onChange={(e) => setSelectedEntityId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 sm:w-72"
                  disabled={loadingDevices || devices.length === 0}
                >
                  <option value="">None</option>
                  {deviceOptions.actionDevices.length > 0 && (
                    <optgroup label="Devices">
                      {deviceOptions.actionDevices.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            </div>
          </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {selectedEntityId ? 'Automations affecting this device' : 'Your automations'}
          </h2>
          {loadingAutomations && <span className="text-xs text-slate-500">Loading…</span>}
        </div>
        {automations.length === 0 && !loadingAutomations && (
          <EmptyState
            title="No automations yet"
            description="Create your first automation to keep your home running exactly how you prefer."
          />
        )}
        {loadingAutomations && automations.length === 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={`automation-skeleton-${index}`} className="h-40 rounded-[16px]" />
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {automations.map((auto) => {
            const fallback = summarizeAutomation({ raw: auto.raw }, devices);
            const summary = {
              triggerSummary: auto.triggerSummary ?? fallback.triggerSummary,
              actionSummary: auto.actionSummary ?? fallback.actionSummary,
              primaryName: auto.primaryName ?? fallback.primaryName,
            };
            return (
              <div
                key={auto.id}
                className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-slate-900 break-words">{auto.alias}</p>
                    <p className="text-xs text-slate-500 break-all">ID: {auto.id}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                        auto.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {auto.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <button
                      type="button"
                      className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                      onClick={() => setAutomationToDelete(auto)}
                      disabled={deletingId === auto.id || auto.canEdit === false}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-600 break-words">{auto.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  {summary.primaryName && (
                    <span className="max-w-full rounded-full bg-slate-100 px-2 py-0.5 break-words">
                      Target: {summary.primaryName}
                    </span>
                  )}
                  {auto.hasTemplates && (
                    <span className="max-w-full rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 break-words">
                      Template detected (view only)
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-1 text-xs text-slate-700">
                  <p className="break-words">
                    <span className="font-semibold text-slate-800">Trigger:</span>{' '}
                    {summary.triggerSummary}
                  </p>
                  <p className="break-words">
                    <span className="font-semibold text-slate-800">Action:</span>{' '}
                    {summary.actionSummary}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Create automation</h2>
        </div>
        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                Name
              </label>
              <input
                type="text"
                value={form.alias}
                onChange={(e) => updateForm('alias', e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                Description (optional)
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => updateForm('description', e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Trigger condition</h3>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    Days (optional)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {weekdayOptions.map((day) => (
                      <label
                        key={day.value}
                        className={`cursor-pointer rounded-lg border px-3 py-1 text-xs ${
                          form.scheduleWeekdays.includes(day.value)
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-white text-slate-600'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={form.scheduleWeekdays.includes(day.value)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setForm((prev) => ({
                              ...prev,
                              scheduleWeekdays: checked
                                ? Array.from(new Set([...prev.scheduleWeekdays, day.value]))
                                : prev.scheduleWeekdays.filter((d) => d !== day.value),
                            }));
                          }}
                        />
                        {day.label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Leave empty for any day. Applied to both time and device triggers.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-semibold text-slate-700">
                        Time
                      </label>
                      <input
                        type="time"
                        value={form.scheduleAt}
                        disabled={form.anyTime}
                        onChange={(e) => updateForm('scheduleAt', e.target.value)}
                        className={`w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 ${
                          form.anyTime ? 'bg-slate-100 text-slate-400 line-through' : ''
                        }`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => updateForm('anyTime', !form.anyTime)}
                      className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                        form.anyTime
                          ? 'border border-indigo-200 bg-indigo-50 text-indigo-700'
                          : 'border border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {form.anyTime ? 'Any Time (on)' : 'Any Time (off)'}
                    </button>
                  </div>
                  {!form.anyTime && (
                    <p className="text-[11px] text-slate-500">
                      Time + Days trigger; device triggers are disabled in this mode.
                    </p>
                  )}
                  {form.anyTime && (
                    <p className="text-[11px] text-slate-500">
                      Any time of day; device trigger below will be used (respecting selected days).
                    </p>
                  )}
                </div>

                {form.anyTime && (
                  <div className="space-y-2">
                    <div>
                      <label className="mb-1 block text-xs">Trigger device</label>
                      <select
                        value={form.triggerEntityId}
                        onChange={(e) => updateForm('triggerEntityId', e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="">None</option>
                        {deviceOptions.triggerDevices.length > 0 && (
                          <optgroup label="Devices">
                            {deviceOptions.triggerDevices.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>

                    {triggerDevice && triggerSpecs.length > 0 && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs">Trigger type</label>
                          <select
                            value={form.triggerMode}
                            onChange={(e) =>
                              updateForm('triggerMode', e.target.value as CreateFormState['triggerMode'])
                            }
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            {triggerSpecs.map((spec) => (
                              <option key={spec.type} value={spec.type}>
                                {spec.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs">Trigger value</label>
                          {renderTriggerInput(
                            triggerSpecs.find((s) => s.type === form.triggerMode) ?? triggerSpecs[0] ?? null,
                            form,
                            (updates) => setForm((prev) => ({ ...prev, ...updates }))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Action</h3>
                <span className="text-[11px] text-slate-500">
                  Choose a device then change its state
                </span>
              </div>
              <div>
                <label className="mb-1 block text-xs">Entity</label>
                <select
                  value={form.actionEntityId}
                  onChange={(e) => updateForm('actionEntityId', e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">None</option>
                  {deviceOptions.actionDevices.length > 0 && (
                    <optgroup label="Devices">
                      {deviceOptions.actionDevices.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              {actionDevice && (
                <>
                  <div>
                    <label className="mb-1 block text-xs">Action</label>
                    <select
                      value={form.actionKind === 'device_command' ? form.actionCommand : ''}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        const spec = primaryActionSpecs.find((s) => s.id === nextId) ?? null;
                        setForm((prev) => {
                          const next: CreateFormState = {
                            ...prev,
                            actionKind: 'device_command',
                            actionCommand: nextId,
                          };
                          if (!spec) return next;
                          if (spec.kind === 'slider') {
                            next.actionValue = spec.min;
                          } else if (spec.kind === 'fixed-position') {
                            next.actionValue = spec.positions[0]?.value ?? '';
                          } else {
                            next.actionValue = '';
                          }
                          return next;
                        });
                      }}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                      disabled={primaryActionSpecs.length === 0}
                    >
                      <option value="">Select action</option>
                      {primaryActionSpecs.map((spec) => (
                        <option key={`${spec.kind}:${spec.id}`} value={spec.id}>
                          {spec.kind === 'fixed-position' ? 'Set position' : spec.label ?? spec.id}
                        </option>
                      ))}
                    </select>
                    {primaryActionSpecs.length === 0 ? (
                      <p className="mt-1 text-[11px] text-slate-500">
                        No dashboard actions available for this device.
                      </p>
                    ) : null}
                  </div>

                  {form.actionKind === 'device_command' && primaryActionSpecs.length > 0 ? (
                    <div>
                      <label className="mb-1 block text-xs">Change state to</label>
                      {renderActionInput(
                        primaryActionSpecs.find((s) => s.id === form.actionCommand) ??
                          primaryActionSpecs[0] ??
                          null,
                        form.actionValue,
                        (v) => updateForm('actionValue', v)
                      )}
                      <p className="mt-1 text-[11px] text-slate-500">
                        Matches the device controls shown on the tenant dashboard card.
                      </p>
                    </div>
                  ) : null}

                  <details className="rounded-lg border border-slate-200 bg-white/70 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                      Advanced services
                    </summary>
                    <div className="mt-3 space-y-3">
                      {advancedServiceSpecs.length > 0 ? (
                        <div>
                          <label className="mb-1 block text-xs">Service</label>
                          <select
                            value={form.actionKind === 'ha_service' ? form.actionServiceId : ''}
                            onChange={(e) => {
                              const nextId = e.target.value;
                              const svc = advancedServiceSpecs.find((s) => s.serviceId === nextId) ?? null;
                              setForm((prev) => {
                                const next: CreateFormState = {
                                  ...prev,
                                  actionKind: 'ha_service',
                                  actionServiceId: nextId,
                                };
                                if (!svc) return next;
                                if (svc.uiKind === 'slider' && svc.sliderSpec) {
                                  next.actionServiceValue = svc.sliderSpec.min;
                                } else if (svc.uiKind === 'select' && svc.selectSpec) {
                                  next.actionServiceValue = svc.selectSpec.options[0] ?? '';
                                } else {
                                  next.actionServiceValue = '';
                                }
                                return next;
                              });
                            }}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            <option value="">Select service</option>
                            {advancedServiceSpecs.map((svc) => (
                              <option key={svc.serviceId} value={svc.serviceId}>
                                {svc.displayLabel}
                              </option>
                            ))}
                          </select>

                          {form.actionKind === 'ha_service' && form.actionServiceId ? (
                            <div className="mt-2">
                              <label className="mb-1 block text-xs">Service input</label>
                              {renderServiceInput(
                                advancedServiceSpecs.find((s) => s.serviceId === form.actionServiceId) ?? null,
                                form.actionServiceValue,
                                (v) => updateForm('actionServiceValue', v)
                              )}
                            </div>
                          ) : null}
                          <p className="mt-1 text-[11px] text-slate-500">
                            Advanced services are service-name based, matching the device card “Advanced actions”.
                          </p>
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-500">No advanced services available.</p>
                      )}
                    </div>
                  </details>
                </>
              )}
              <div className="flex items-center gap-2 pt-1">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => updateForm('enabled', e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="enabled" className="text-sm text-slate-700">
                  Enabled
                </label>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setForm({ ...defaultFormState });
              }}
            >
              Reset
            </button>
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Create automation'}
            </button>
          </div>
        </form>
      </section>

      <Modal
        open={Boolean(automationToDelete)}
        onClose={() => setAutomationToDelete(null)}
        title="Remove this automation?"
        description="This will stop this automation from running for your home."
        width="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Automation:{' '}
            <span className="font-semibold text-foreground">
              {automationToDelete?.alias}
            </span>
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              loading={deletingId === automationToDelete?.id}
              onClick={() => {
                if (!automationToDelete) return;
                void handleDelete(automationToDelete.id);
              }}
            >
              Remove automation
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setAutomationToDelete(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
