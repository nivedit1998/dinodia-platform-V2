// Architecture: App Router surface src/app/devices/manage/ui/ManageDevices.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';

type DeviceStatus = 'ACTIVE' | 'STOLEN' | 'BLOCKED';

type Device = {
  id: string;
  deviceId: string;
  label: string | null;
  registryLabel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  status: DeviceStatus;
};

type LoadState = { loading: boolean; error: string | null };

export default function ManageDevices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ loading: true, error: null });
  const [actionState, setActionState] = useState<Record<string, { saving: boolean; error: string | null }>>(
    {}
  );

  const loadDevices = useCallback(async () => {
    setLoadState({ loading: true, error: null });
    try {
      const data = await platformFetchJson<{ devices?: Device[] }>(
        '/api/devices/manage',
        { cache: 'no-store' },
        'Unable to load devices.'
      );
      setDevices(data.devices || []);
      setLoadState({ loading: false, error: null });
    } catch (err) {
      setLoadState({
        loading: false,
        error: friendlyUnknownError(err, 'Unable to load devices.'),
      });
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const markStolen = useCallback(
    async (deviceId: string) => {
      setActionState((prev) => ({ ...prev, [deviceId]: { saving: true, error: null } }));
      try {
        await platformFetchJson<{ ok: boolean }>(
          '/api/devices/manage/stolen',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
          },
          'Unable to mark device as stolen.'
        );
        await loadDevices();
        setActionState((prev) => ({ ...prev, [deviceId]: { saving: false, error: null } }));
      } catch (err) {
        setActionState((prev) => ({
          ...prev,
          [deviceId]: {
            saving: false,
            error: friendlyUnknownError(err, 'Unable to mark device as stolen.'),
          },
        }));
      }
    },
    [loadDevices]
  );

  const restoreDevice = useCallback(
    async (deviceId: string) => {
      setActionState((prev) => ({ ...prev, [deviceId]: { saving: true, error: null } }));
      try {
        await platformFetchJson<{ ok: boolean }>(
          '/api/devices/manage/restore',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
          },
          'Unable to restore device.'
        );
        await loadDevices();
        setActionState((prev) => ({ ...prev, [deviceId]: { saving: false, error: null } }));
      } catch (err) {
        setActionState((prev) => ({
          ...prev,
          [deviceId]: {
            saving: false,
            error: friendlyUnknownError(err, 'Unable to restore device.'),
          },
        }));
      }
    },
    [loadDevices]
  );

  const rows = useMemo(() => {
    return devices.map((d) => {
      const statusCopy =
        d.status === 'ACTIVE'
          ? 'Active'
          : d.status === 'STOLEN'
          ? 'Stolen'
          : 'Blocked';
      const state = actionState[d.deviceId] || { saving: false, error: null };
      return (
        <div
          key={d.deviceId}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col gap-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {d.label || d.registryLabel || 'Unnamed device'}
              </div>
              <div className="text-xs text-slate-500 break-all">ID: {d.deviceId}</div>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                d.status === 'ACTIVE'
                  ? 'bg-emerald-50 text-emerald-700'
                  : d.status === 'STOLEN'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              {statusCopy}
            </span>
          </div>
          <div className="text-xs text-slate-600">
            <div>First seen: {new Date(d.firstSeenAt).toLocaleString()}</div>
            <div>Last seen: {new Date(d.lastSeenAt).toLocaleString()}</div>
            {d.revokedAt ? <div>Revoked: {new Date(d.revokedAt).toLocaleString()}</div> : null}
          </div>
          {state.error ? (
            <div className="text-xs text-red-600">{state.error}</div>
          ) : null}
          <div className="flex gap-2">
            {d.status === 'ACTIVE' ? (
              <button
                className="rounded-lg bg-red-600 text-white text-sm px-3 py-2 disabled:opacity-60"
                onClick={() => markStolen(d.deviceId)}
                disabled={state.saving}
              >
                {state.saving ? 'Updating…' : 'Mark stolen'}
              </button>
            ) : (
              <button
                className="rounded-lg bg-emerald-600 text-white text-sm px-3 py-2 disabled:opacity-60"
                onClick={() => restoreDevice(d.deviceId)}
                disabled={state.saving}
              >
                {state.saving ? 'Updating…' : 'Restore device'}
              </button>
            )}
          </div>
        </div>
      );
    });
  }, [devices, actionState, markStolen, restoreDevice]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">Manage Devices</h1>
        <p className="text-sm text-slate-600">
          Block stolen or lost devices. A stolen device cannot fetch HA secrets or control your home.
        </p>
      </div>

      {loadState.loading ? (
        <div className="text-sm text-slate-600">Loading devices…</div>
      ) : loadState.error ? (
        <div className="text-sm text-red-600">{loadState.error}</div>
      ) : devices.length === 0 ? (
        <div className="text-sm text-slate-600">No devices found for your account.</div>
      ) : (
        <div className="grid gap-3">{rows}</div>
      )}
    </div>
  );
}
