// Architecture: Reusable web UI component src/components/device/DeviceDetailSheet.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useEffect, useMemo, useState } from 'react';
import { UIDevice } from '@/types/device';
import { getPrimaryLabel } from '@/lib/deviceLabels';
import { DeviceControls } from './DeviceControls';
import {
  getDetailAccent,
  getDeviceArea,
  getDeviceSecondaryText,
  getVisualPreset,
} from './deviceVisuals';
import { platformFetch } from '@/lib/platformFetchClient';

type TenantVirtualArea = {
  id: string;
  parentHaAreaName: string;
  parentDisplayAreaName?: string | null;
  displayName: string;
};

type TenantAreaOption = {
  haAreaName: string;
  displayName: string;
  displayKey?: string;
};

type DeviceDetailSheetProps = {
  device: UIDevice;
  onClose: () => void;
  onActionComplete?: () => void;
  relatedDevices?: UIDevice[];
  showAdminControls?: boolean;
  allowSensorHistory?: boolean;
  historyEndpoint?: string;
  onOpenAdminEdit?: () => void;
  linkedSensors?: UIDevice[];
  allowDeviceControl?: boolean;
  showControlsSection?: boolean;
  showStateText?: boolean;
};

export function DeviceDetailSheet({
  device,
  onClose,
  onActionComplete,
  relatedDevices,
  showAdminControls = false,
  allowSensorHistory = true,
  historyEndpoint = '/api/admin/monitoring/history',
  onOpenAdminEdit,
  linkedSensors,
  allowDeviceControl = true,
  showControlsSection = true,
  showStateText = true,
}: DeviceDetailSheetProps) {
  const label = getPrimaryLabel(device);
  const accent = getDetailAccent(label);
  const visual = getVisualPreset(label);
  const Icon = visual.icon;
  const secondary = useMemo(
    () => getDeviceSecondaryText(label, device),
    [label, device]
  );
  const area = useMemo(() => getDeviceArea(device), [device]);
  const [visible, setVisible] = useState(false);
  const [showAllSensors, setShowAllSensors] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  const [showMoveDevice, setShowMoveDevice] = useState(false);
  const [moveAreaOptions, setMoveAreaOptions] = useState<TenantAreaOption[]>([]);
  const [moveVirtualAreas, setMoveVirtualAreas] = useState<TenantVirtualArea[]>([]);
  const [moveParentAreaName, setMoveParentAreaName] = useState('');
  const [moveVirtualAreaId, setMoveVirtualAreaId] = useState('');
  const [moveNewVirtualSubAreaName, setMoveNewVirtualSubAreaName] = useState('');
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveSaving, setMoveSaving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [tenantMutationBusy, setTenantMutationBusy] = useState(false);

  const canMoveTenantDevice = !showAdminControls && device.ownership === 'tenant_owned';
  const moveVirtualAreasForParent = moveVirtualAreas.filter(
    (area) =>
      area.parentHaAreaName === moveParentAreaName ||
      area.parentDisplayAreaName === moveParentAreaName
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (!showMoveDevice) return;
    let cancelled = false;
    async function loadMoveOptions() {
      setMoveLoading(true);
      setMoveError(null);
      try {
        const [rosterRes, virtualRes] = await Promise.all([
          platformFetch('/api/tenant/access-roster', { cache: 'no-store' }),
          platformFetch('/api/tenant/virtual-areas', { cache: 'no-store' }),
        ]);
        const [rosterData, virtualData] = await Promise.all([rosterRes.json(), virtualRes.json()]);
        if (cancelled) return;
        if (!rosterRes.ok) throw new Error(rosterData?.error || 'Unable to load your areas.');
        if (!virtualRes.ok) throw new Error(virtualData?.error || 'Unable to load your sub-areas.');
        const areaOptions = Array.isArray(rosterData?.tenantAreaOptions)
          ? rosterData.tenantAreaOptions.filter(
              (area: TenantAreaOption | null | undefined): area is TenantAreaOption =>
                Boolean(area?.haAreaName && area?.displayName)
            )
          : [];
        setMoveAreaOptions(areaOptions);
        setMoveVirtualAreas(Array.isArray(virtualData?.virtualAreas) ? virtualData.virtualAreas : []);
        const fallbackArea =
          device.parentAreaName ||
          device.sourceAreaName ||
          device.areaName ||
          device.area ||
          areaOptions[0]?.haAreaName ||
          '';
        setMoveParentAreaName((current) => current || fallbackArea);
        setMoveVirtualAreaId(device.tenantVirtualAreaId || '');
      } catch (err) {
        if (!cancelled) {
          setMoveError(err instanceof Error ? err.message : 'Unable to load move options.');
        }
      } finally {
        if (!cancelled) setMoveLoading(false);
      }
    }
    void loadMoveOptions();
    return () => {
      cancelled = true;
    };
  }, [device.area, device.areaName, device.parentAreaName, device.sourceAreaName, device.tenantVirtualAreaId, showMoveDevice]);

  const previewCount = 2;
  const hasMoreSensors =
    Array.isArray(linkedSensors) && linkedSensors.length > previewCount;
  const visibleSensors = Array.isArray(linkedSensors)
    ? showAllSensors
      ? linkedSensors
      : linkedSensors.slice(0, previewCount)
    : [];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-6 transition sm:items-center ${
        visible ? 'bg-slate-900/40' : 'bg-slate-900/0'
      }`}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-4xl overflow-hidden rounded-[32px] border border-white/30 bg-white/90 shadow-2xl backdrop-blur-2xl transition-all duration-300 ${
          visible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
        }`}
      >
        <div className="flex max-h-[90vh] flex-col sm:max-h-[85vh]">
          <div
            className={`rounded-[32px] bg-gradient-to-br ${accent} p-5 sm:p-8`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5 text-slate-900">
                <p className="text-[11px] uppercase tracking-[0.38em] text-slate-500">
                  {label}
                </p>
                <h2 className="text-2xl font-semibold sm:text-3xl">
                  {device.displayName ?? device.name}
                </h2>
                {showStateText && (
                  <p className="text-sm text-slate-600">{secondary}</p>
                )}
                <p className="text-xs text-slate-500">
                  Area • <span className="text-slate-700">{area}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {showAdminControls && (
                  <button
                    type="button"
                    aria-label="Edit device"
                    onClick={() => onOpenAdminEdit?.()}
                    className="rounded-full bg-white/80 px-3 py-2 text-lg text-slate-500 shadow"
                  >
                    ⋯
                  </button>
                )}
                {canMoveTenantDevice && (
                  <button
                    type="button"
                    aria-label="Edit device"
                    onClick={() => void editTenantDevice()}
                    disabled={tenantMutationBusy}
                    className="rounded-full bg-white/80 px-3 py-2 text-sm font-semibold text-slate-600 shadow disabled:opacity-50"
                  >
                    Edit
                  </button>
                )}
                {canMoveTenantDevice && (
                  <button
                    type="button"
                    aria-label="Move device"
                    onClick={() => {
                      setMoveParentAreaName(
                        device.parentAreaName ||
                          device.sourceAreaName ||
                          device.areaName ||
                          device.area ||
                          ''
                      );
                      setMoveVirtualAreaId(device.tenantVirtualAreaId || '');
                      setMoveNewVirtualSubAreaName('');
                      setMoveError(null);
                      setShowMoveDevice(true);
                    }}
                    className="rounded-full bg-white/80 px-3 py-2 text-sm font-semibold text-slate-600 shadow"
                  >
                    Move
                  </button>
                )}
                {canMoveTenantDevice && (
                  <button
                    type="button"
                    aria-label="Delete device"
                    onClick={() => void deleteTenantDevice()}
                    disabled={tenantMutationBusy}
                    className="rounded-full bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-600 shadow disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="rounded-full bg-white/80 p-2 text-slate-500 shadow"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-4 text-slate-700">
              <div className="rounded-3xl bg-white/70 p-4 shadow">
                <Icon className="h-9 w-9 text-slate-900 sm:h-10 sm:w-10" />
              </div>
              {showControlsSection && (
                <div className="text-sm text-slate-600">
                  {allowDeviceControl ? 'Live controls for ' : 'View only • '}
                  <span className="font-medium text-slate-900">{device.displayName ?? device.name}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-5 sm:p-8">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
              <div className={Array.isArray(linkedSensors) && linkedSensors.length > 0 ? 'lg:col-span-3' : 'lg:col-span-5'}>
                {showControlsSection ? (
                  <DeviceControls
                    device={device}
                    onActionComplete={onActionComplete}
                    relatedDevices={relatedDevices}
                    allowDeviceControl={allowDeviceControl}
                  />
                ) : null}
              </div>
              {Array.isArray(linkedSensors) && linkedSensors.length > 0 && (
                <div className="lg:col-span-2">
                  <div className="space-y-4 rounded-3xl border border-slate-100 bg-white/70 p-4 shadow-sm sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400">
                          Linked sensors
                        </p>
                        <p className="text-sm text-slate-600">
                          Live readouts from linked entities
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                          {linkedSensors.length} linked
                        </span>
                        {hasMoreSensors && (
                          <button
                            type="button"
                            onClick={() => setShowAllSensors((prev) => !prev)}
                            aria-expanded={showAllSensors}
                            className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-white"
                          >
                            {showAllSensors ? 'Show fewer' : 'Show all'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="relative">
                      <div className="grid grid-cols-1 gap-3">
                        {visibleSensors.map((sensor) => (
                          <SensorCard
                            key={sensor.entityId}
                            sensor={sensor}
                            allowSensorHistory={allowSensorHistory}
                            historyEndpoint={historyEndpoint}
                          />
                        ))}
                      </div>
                      {!showAllSensors && hasMoreSensors && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white/95 to-transparent" />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {showMoveDevice && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 px-4"
          onClick={() => setShowMoveDevice(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Move device</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Choose a parent area and optional private sub-area for {device.displayName ?? device.name}.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full bg-slate-100 px-3 py-1 text-slate-500"
                onClick={() => setShowMoveDevice(false)}
              >
                ×
              </button>
            </div>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                Parent area
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={moveParentAreaName}
                  onChange={(event) => {
                    setMoveParentAreaName(event.target.value);
                    setMoveVirtualAreaId('');
                    setMoveNewVirtualSubAreaName('');
                  }}
                  disabled={moveLoading}
                >
                  <option value="">{moveLoading ? 'Loading areas...' : 'Choose area'}</option>
                  {moveAreaOptions.map((areaOption) => (
                    <option key={`${areaOption.haAreaName}-${areaOption.displayName}`} value={areaOption.haAreaName}>
                      {areaOption.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Sub-area
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={moveVirtualAreaId}
                  onChange={(event) => {
                    setMoveVirtualAreaId(event.target.value);
                    if (event.target.value) setMoveNewVirtualSubAreaName('');
                  }}
                  disabled={moveLoading || !moveParentAreaName}
                >
                  <option value="">None</option>
                  {moveVirtualAreasForParent.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Or create new sub-area
                <input
                  type="text"
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={moveNewVirtualSubAreaName}
                  onChange={(event) => {
                    setMoveNewVirtualSubAreaName(event.target.value);
                    if (event.target.value.trim()) setMoveVirtualAreaId('');
                  }}
                  placeholder="Example: Desk, Counter"
                />
              </label>
              {moveError && <p className="text-sm text-rose-600">{moveError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600"
                  onClick={() => setShowMoveDevice(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={moveSaving || !moveParentAreaName.trim()}
                  onClick={() => void saveMoveDevice()}
                >
                  {moveSaving ? 'Moving…' : 'Move'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  async function saveMoveDevice() {
    const targetDeviceId = device.deviceId || device.entityId;
    if (!moveParentAreaName.trim()) {
      setMoveError('Please choose an area.');
      return;
    }
    setMoveSaving(true);
    setMoveError(null);
    try {
      const res = await platformFetch(`/api/tenant/devices/${encodeURIComponent(targetDeviceId)}/move`, {
        method: 'POST',
        body: JSON.stringify({
          parentAreaName: moveParentAreaName.trim(),
          selectedVirtualAreaId: moveVirtualAreaId || null,
          newVirtualSubAreaName: moveNewVirtualSubAreaName.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Unable to move this device.');
      setShowMoveDevice(false);
      onActionComplete?.();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Unable to move this device.');
    } finally {
      setMoveSaving(false);
    }
  }

  async function editTenantDevice() {
    const targetDeviceId = device.deviceId || device.entityId;
    const nextName = window.prompt('Device name', device.displayName ?? device.name);
    if (nextName == null) return;
    const trimmedName = nextName.trim();
    if (!trimmedName) return;

    setTenantMutationBusy(true);
    try {
      const res = await platformFetch(`/api/tenant/devices/${encodeURIComponent(targetDeviceId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: trimmedName,
          displayLabel: device.displayLabel ?? device.label ?? null,
          parentAreaName:
            device.parentAreaName || device.sourceAreaName || device.areaName || device.area || null,
          selectedVirtualAreaId: device.tenantVirtualAreaId || null,
          newVirtualSubAreaName: null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Unable to update this device.');
      onActionComplete?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Unable to update this device.');
    } finally {
      setTenantMutationBusy(false);
    }
  }

  async function deleteTenantDevice() {
    const targetDeviceId = device.deviceId || device.entityId;
    if (!window.confirm(`Delete ${device.displayName ?? device.name}?`)) return;

    setTenantMutationBusy(true);
    try {
      const res = await platformFetch(`/api/tenant/devices/${encodeURIComponent(targetDeviceId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Unable to delete this device.');
      onClose();
      onActionComplete?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Unable to delete this device.');
    } finally {
      setTenantMutationBusy(false);
    }
  }
}

type HistoryPoint = {
  bucketStart: string;
  label: string;
  value: number;
  count: number;
};

function SensorCard({
  sensor,
  allowSensorHistory = true,
  historyEndpoint = '/api/admin/monitoring/history',
}: {
  sensor: UIDevice;
  allowSensorHistory?: boolean;
  historyEndpoint?: string;
}) {
  const reading = formatSensorReading(sensor);
  const extras = getSensorAttributes(sensor);
  const [expanded, setExpanded] = useState(false);
  const [bucket, setBucket] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [historyUnit, setHistoryUnit] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (allowSensorHistory) return;
    setExpanded(false);
    setHistory(null);
    setHistoryUnit(null);
    setHistoryError(null);
  }, [allowSensorHistory]);

  useEffect(() => {
    if (!allowSensorHistory || !expanded) return;

    let aborted = false;
    const controller = new AbortController();

    async function loadHistory() {
      setHistoryLoading(true);
      setHistoryError(null);
    try {
      const params = new URLSearchParams({
        entityId: sensor.entityId,
        bucket,
      });
      const res = await platformFetch(`${historyEndpoint}?${params.toString()}`, {
        signal: controller.signal,
      });
        const data = await res.json();
        if (aborted) return;
        if (!res.ok || !data.ok) {
          setHistoryError(
            data.error ||
              'We couldn’t load this history right now. Please check your connection and try again.'
          );
          setHistory(null);
          setHistoryUnit(null);
          return;
        }
        setHistory(Array.isArray(data.points) ? data.points : []);
        setHistoryUnit(typeof data.unit === 'string' ? data.unit : null);
      } catch (err) {
        if (aborted) return;
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setHistoryError(
          'We couldn’t load this history right now. Please check your connection and try again.'
        );
        setHistory(null);
        setHistoryUnit(null);
      } finally {
        if (!aborted) {
          setHistoryLoading(false);
        }
      }
    }

    void loadHistory();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, [allowSensorHistory, expanded, bucket, historyEndpoint, sensor.entityId]);

  return (
    <div className="rounded-2xl border border-slate-100 bg-white/80 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.32em] text-slate-400">
            {sensor.displayLabel || sensor.canonicalLabel || sensor.label || sensor.labelCategory || 'Sensor'}
          </p>
          <p className="text-sm font-semibold text-slate-900">{sensor.displayName ?? sensor.name}</p>
          <p className="text-xs text-slate-500">{reading}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="rounded-xl bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            {formatState(sensor.state)}
          </span>
          {allowSensorHistory && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="text-[11px] rounded-full bg-slate-100 px-2 py-1 text-slate-600 hover:bg-slate-200"
            >
              {expanded ? 'Hide history' : 'History'}
            </button>
          )}
        </div>
      </div>
      {extras.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
          {extras.map((attr) => (
            <span
              key={attr.label}
              className="rounded-full bg-slate-50 px-2 py-1 shadow-inner"
            >
              {attr.label}: {attr.value}
            </span>
          ))}
        </div>
      )}
      {allowSensorHistory && expanded && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-600">
            <span className="uppercase tracking-[0.18em] text-slate-400">
              History
            </span>
            {(['daily', 'weekly', 'monthly'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setBucket(key)}
                className={[
                  'rounded-full px-2 py-1',
                  'border text-[11px]',
                  bucket === key
                    ? 'border-slate-500 bg-slate-600 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100',
                ].join(' ')}
              >
                {key === 'daily' ? 'Daily' : key === 'weekly' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
            {historyLoading && <p>Loading...</p>}
            {historyError && !historyLoading && (
              <p className="text-red-500">{historyError}</p>
            )}
            {!historyLoading && !historyError && history && history.length === 0 && (
              <p>No history recorded yet for this device.</p>
            )}
            {!historyLoading && !historyError && history && history.length > 0 && (
              <ul className="space-y-1">
                {history.map((point) => (
                  <li key={point.bucketStart} className="flex justify-between gap-2">
                    <span>{point.label}</span>
                    <span className="font-medium">
                      {point.value.toFixed(2)}
                      {historyUnit ? ` ${historyUnit}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatState(state: string) {
  return state
    ? state
        .toString()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Unknown';
}

function formatSensorReading(sensor: UIDevice) {
  const attrs = sensor.attributes || {};
  const unit =
    typeof attrs.unit_of_measurement === 'string'
      ? attrs.unit_of_measurement
      : '';
  const stateText = formatState(sensor.state);
  return unit ? `${stateText} ${unit}` : stateText;
}

function formatAttributeValue(key: string, value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const suffix =
      key.includes('battery') || key.includes('humidity') ? '%' : '';
    if (!Number.isFinite(value)) return '';
    return `${value}${suffix}`;
  }
  if (typeof value === 'string') return value;
  return '';
}

function getSensorAttributes(sensor: UIDevice) {
  const attrs = sensor.attributes || {};
  const keys: Record<string, string> = {
    temperature: 'Temp',
    humidity: 'Humidity',
    battery: 'Battery',
    battery_level: 'Battery',
    power: 'Power',
    voltage: 'Voltage',
    current: 'Current',
    illuminance: 'Light',
    pressure: 'Pressure',
  };
  const extras: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [key, label] of Object.entries(keys)) {
    const value = attrs[key];
    const formatted = formatAttributeValue(key, value);
    if (formatted && !seen.has(label)) {
      extras.push({ label, value: formatted });
      seen.add(label);
    }
  }
  return extras;
}
