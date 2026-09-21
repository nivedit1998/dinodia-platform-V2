// Architecture: App Router surface src/app/tenant/ui/TenantDashboard.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UIDevice } from '@/types/device';
import { getGroupLabel, sortLabels, OTHER_LABEL } from '@/lib/deviceLabels';
import { isSensorEntity } from '@/lib/deviceSensors';
import { getDeviceGroupingId } from '@/lib/deviceIdentity';
import { DeviceTile } from '@/components/device/DeviceTile';
import { DeviceDetailSheet } from '@/components/device/DeviceDetailSheet';
import { subscribeToRefresh } from '@/lib/refreshBus';
import { logout as performLogout } from '@/lib/logout';
import Image from 'next/image';
import { getTenantDashboardDevices } from '@/lib/deviceCapabilities';
import { useDevicesVersionPolling } from '@/lib/useDevicesVersionPolling';
import TenantAccessRosterDialog from './TenantAccessRosterDialog';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { TriggerDeviceDetailSheet } from '@/components/trigger-device/TriggerDeviceDetailSheet';
import { TriggerDeviceTile } from '@/components/trigger-device/TriggerDeviceTile';
import type { TriggerDeviceSummary, TriggerTargetOption } from '@/types/triggerDevice';
import { fetchTenantInventorySnapshot, invalidateTenantInventorySnapshot } from '@/lib/tenantInventoryClient';
import { isTenantDeviceLabelValue } from '@/lib/tenantDeviceLabel';

type Props = {
  username: string;
};

const ALL_AREAS = 'All areas';
const REFRESH_THROTTLE_MS = 3000;
const STABLE_FAILURE_EXPOSURE_MS = 60_000;
const ALEXA_SKILL_URL = 'https://www.amazon.co.uk/gp/product/B0GGCC4BDS?nodl=0';

type SupportMeta = {
  kind: 'HOME_ACCESS' | 'USER_REMOTE_ACCESS';
  requestId: string;
  approvedAt: string;
  validUntil: string;
  viaUser?: { id: number; username: string; role: 'ADMIN' | 'TENANT' } | null;
};

type AccessUser = {
  id: number;
  username: string;
  role: 'ADMIN' | 'TENANT' | 'INSTALLER';
  roleLabel: 'Homeowner' | 'Tenant' | 'Support Agent';
  email: string | null;
  emailMasked: boolean;
  areas: string[];
  support?: SupportMeta | null;
};

type AccessRoster = {
  ok: true;
  tenantAreas: string[];
  counts: { uniqueUsers: number; uniqueOtherUsers: number };
  users: AccessUser[];
};

type AreaShareSummary = Record<
  string,
  { otherTenants: number; supportAgents: number; homeowners: number }
>;

type UsersByArea = Record<string, AccessUser[]>;

type DashboardTileItem =
  | { kind: 'device'; id: string; device: UIDevice }
  | { kind: 'trigger'; id: string; triggerDevice: TriggerDeviceSummary };

function getTriggerDeviceLabel(triggerDevice: TriggerDeviceSummary) {
  const nonTenantDeviceLabel = triggerDevice.labels
    ?.find((label) => label?.trim() && !isTenantDeviceLabelValue(label))
    ?.trim();
  return (
    (triggerDevice.displayLabel ?? '').trim() ||
    (triggerDevice.label ?? '').trim() ||
    nonTenantDeviceLabel ||
    triggerDevice.labels?.find((label) => label?.trim())?.trim() ||
    (triggerDevice.labelCategory ?? '').trim() ||
    'Trigger'
  );
}

function devicesAreDifferent(a: UIDevice[], b: UIDevice[]) {
  if (a.length !== b.length) return true;
  const mapA = new Map(a.map((d) => [d.entityId, d]));
  for (const d of b) {
    const prev = mapA.get(d.entityId);
    if (!prev) return true;
    if (
      prev.state !== d.state ||
      prev.name !== d.name ||
      prev.displayName !== d.displayName ||
      prev.displayAreaName !== d.displayAreaName ||
      prev.displayLabel !== d.displayLabel ||
      prev.ownership !== d.ownership ||
      (prev.area ?? prev.areaName) !== (d.area ?? d.areaName) ||
      prev.label !== d.label ||
      prev.labelCategory !== d.labelCategory ||
      prev.deviceId !== d.deviceId
    ) {
      return true;
    }
  }
  return false;
}

function triggerDevicesAreDifferent(a: TriggerDeviceSummary[], b: TriggerDeviceSummary[]) {
  if (a.length !== b.length) return true;
  const mapA = new Map(a.map((d) => [d.triggerDeviceId, d]));
  for (const device of b) {
    const prev = mapA.get(device.triggerDeviceId);
    if (!prev) return true;
    if (
      prev.name !== device.name ||
      prev.displayName !== device.displayName ||
      prev.displayAreaName !== device.displayAreaName ||
      prev.displayLabel !== device.displayLabel ||
      prev.ownership !== device.ownership ||
      prev.state !== device.state ||
      (prev.area ?? prev.areaName) !== (device.area ?? device.areaName) ||
      (prev.sourceTechnicalLabel ?? null) !== (device.sourceTechnicalLabel ?? null) ||
      prev.binding?.targetEntityId !== device.binding?.targetEntityId ||
      prev.binding?.targetDeviceId !== device.binding?.targetDeviceId ||
      prev.binding?.bindingId !== device.binding?.bindingId ||
      prev.resolutionState !== device.resolutionState ||
      prev.target?.targetId !== device.target?.targetId ||
      prev.target?.entityId !== device.target?.entityId ||
      prev.target?.deviceId !== device.target?.deviceId ||
      prev.target?.name !== device.target?.name
    ) {
      return true;
    }
  }
  return false;
}

type TenantDeviceDeleteResult = {
  ok?: boolean;
  alreadyRemoved?: boolean;
  removedDeviceId?: string | null;
  removedEntityIds?: string[];
  removedTriggerBindings?: number;
  zigbeeRejoinPossible?: boolean;
  postDeleteNotice?: string | null;
};

function formatClock(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    weekday: 'short',
  }).format(date);
}

export default function TenantDashboard(props: Props) {
  const { username } = props;
  const router = useRouter();
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
  const [openTriggerDeviceId, setOpenTriggerDeviceId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [devices, setDevices] = useState<UIDevice[]>([]);
  const [triggerDevices, setTriggerDevices] = useState<TriggerDeviceSummary[]>([]);
  const [previewTriggerDevices, setPreviewTriggerDevices] = useState<TriggerDeviceSummary[]>([]);
  const [acceptedTriggerDeviceIds, setAcceptedTriggerDeviceIds] = useState<Set<string>>(new Set());
  const [triggerTargetOptions, setTriggerTargetOptions] = useState<TriggerTargetOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [triggerDeviceError, setTriggerDeviceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [triggerDeviceLoading, setTriggerDeviceLoading] = useState(false);
  const requestCounterRef = useRef(0);
  const latestRequestRef = useRef(0);
  const lastLoadedRef = useRef<number | null>(null);
  const initialLoadStartedAtRef = useRef<number>(Date.now());
  const hasLoadedDevicesOnceRef = useRef(false);
  const hasLoadedTriggerDevicesOnceRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const triggerDeviceRequestCounterRef = useRef(0);
  const latestTriggerDeviceRequestRef = useRef(0);
  const triggerDeviceLastLoadedRef = useRef<number | null>(null);
  const triggerDeviceAbortControllerRef = useRef<AbortController | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectedArea, setSelectedArea] = useState<string>(() => {
    if (typeof window === 'undefined') return ALL_AREAS;
    try {
      return localStorage.getItem('tenantSelectedArea') || ALL_AREAS;
    } catch {
      return ALL_AREAS;
    }
  });
  const [areaMenuOpen, setAreaMenuOpen] = useState(false);
  const areaMenuRef = useRef<HTMLDivElement | null>(null);
  const [showAlexaLink, setShowAlexaLink] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [roster, setRoster] = useState<AccessRoster | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'area' | 'user'>('area');

  const resolveDeviceErrorMessage = useCallback(async () => {
    return (
      'We couldn’t load your devices. Please check your connection and try again.'
    );
  }, []);

  const loadInventory = useCallback(
    async (opts?: { silent?: boolean; force?: boolean }) => {
      const silent = opts?.silent ?? false;
      const force = opts?.force ?? false;
      const now = Date.now();
      const lastLoaded = lastLoadedRef.current;
      if (!force && lastLoaded && now - lastLoaded < REFRESH_THROTTLE_MS) {
        setLoading(false);
        setTriggerDeviceLoading(false);
        return;
      }

      const requestId = requestCounterRef.current + 1;
      requestCounterRef.current = requestId;
      latestRequestRef.current = requestId;
      latestTriggerDeviceRequestRef.current = requestId;

      if (!silent) {
        setError(null);
        setTriggerDeviceError(null);
      }
      setLoading(true);
      setTriggerDeviceLoading(true);

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (triggerDeviceAbortControllerRef.current) {
        triggerDeviceAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      triggerDeviceAbortControllerRef.current = controller;

      try {
        const data = await fetchTenantInventorySnapshot({ force, preferWarm: true });
        const isLatest = latestRequestRef.current === requestId;
        if (!isLatest) return;

        setLoading(false);
        setTriggerDeviceLoading(false);
        abortControllerRef.current = null;
        triggerDeviceAbortControllerRef.current = null;

        const list: UIDevice[] = data.devices || [];
        const previewList: TriggerDeviceSummary[] = data.previewTriggerDevices || [];
        const acceptedIds = new Set(
          (data.acceptedTriggerDeviceIds || [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        );
        const triggerList: TriggerDeviceSummary[] = data.triggerDevices || [];
        const targetOptions: TriggerTargetOption[] = data.targetOptions || [];
        setDevices((prev) => {
          if (!devicesAreDifferent(prev, list)) return prev;
          return list;
        });
        setPreviewTriggerDevices((prev) => {
          if (!triggerDevicesAreDifferent(prev, previewList)) return prev;
          return previewList;
        });
        setAcceptedTriggerDeviceIds((prev) => {
          if (prev.size === acceptedIds.size && Array.from(prev).every((value) => acceptedIds.has(value))) {
            return prev;
          }
          return acceptedIds;
        });
        setTriggerDevices((prev) => {
          if (!triggerDevicesAreDifferent(prev, triggerList)) return prev;
          return triggerList;
        });
        setTriggerTargetOptions(targetOptions);
        hasLoadedDevicesOnceRef.current = true;
        hasLoadedTriggerDevicesOnceRef.current = true;
        lastLoadedRef.current = Date.now();
        triggerDeviceLastLoadedRef.current = Date.now();
      } catch (err) {
        const isLatest = latestRequestRef.current === requestId;
        if (!isLatest) return;
        if ((err as Error).name === 'AbortError') {
          setLoading(false);
          setTriggerDeviceLoading(false);
          abortControllerRef.current = null;
          triggerDeviceAbortControllerRef.current = null;
          return;
        }
        setLoading(false);
        setTriggerDeviceLoading(false);
        abortControllerRef.current = null;
        triggerDeviceAbortControllerRef.current = null;
        const friendly = friendlyUnknownError(err, await resolveDeviceErrorMessage());
        if (latestRequestRef.current !== requestId) return;
        setError(friendly);
        setTriggerDeviceError(friendly);
        window.setTimeout(() => {
          if (!openDeviceId && !openTriggerDeviceId) void loadInventory({ silent: true });
        }, 10_000);
      }
    },
    [openDeviceId, openTriggerDeviceId, resolveDeviceErrorMessage]
  );

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setDeviceMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!areaMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (
        areaMenuRef.current &&
        !areaMenuRef.current.contains(event.target as Node)
      ) {
        setAreaMenuOpen(false);
        setDeviceMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setAreaMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [areaMenuOpen]);

  useEffect(() => {
    if (!deviceMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(event.target as Node)) {
        setDeviceMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setDeviceMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [deviceMenuOpen]);

  useEffect(() => {
    initialLoadStartedAtRef.current = Date.now();
    hasLoadedDevicesOnceRef.current = false;
    hasLoadedTriggerDevicesOnceRef.current = false;
    const frame = requestAnimationFrame(() => {
      void loadInventory();
    });
    return () => cancelAnimationFrame(frame);
  }, [loadInventory]);

  const loadRoster = useCallback(async () => {
    setRosterError(null);
    setRosterLoading(true);
    try {
      const data = await platformFetchJson<AccessRoster>(
        '/api/tenant/access-roster',
        {
          cache: 'no-store',
          credentials: 'include',
        },
        'Unable to load access roster.'
      );
      setRoster(data as AccessRoster);
    } catch (err) {
      setRosterError(friendlyUnknownError(err, 'We could not load who has access. Please try again.'));
    } finally {
      setRosterLoading(false);
    }
  }, []);

  const handleVersionChange = useCallback(() => {
    invalidateTenantInventorySnapshot();
    void loadInventory({ silent: true, force: true });
  }, [loadInventory]);

  useDevicesVersionPolling({
    onVersionChange: handleVersionChange,
  });

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    let active = true;
    async function checkAlexaDevices() {
      try {
        const data = await platformFetchJson<{ devices?: unknown[] }>(
          '/api/alexa/devices',
          {
            cache: 'no-store',
            credentials: 'include',
          },
          'Unsuccessful - Alexa device status is not available right now.'
        );
        if (!active) return;
        const list = Array.isArray(data.devices) ? data.devices : [];
        setShowAlexaLink(list.length > 0);
      } catch {
        if (active) {
          setShowAlexaLink(false);
        }
      }
    }
    void checkAlexaDevices();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToRefresh(() => {
      invalidateTenantInventorySnapshot();
      void loadInventory({ silent: true });
    });
    return unsubscribe;
  }, [loadInventory]);

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock(new Date())), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      triggerDeviceAbortControllerRef.current?.abort();
    },
    []
  );

  const hasDevices = devices.length > 0 || triggerDevices.length > 0;
  const shouldSurfaceStableFailure =
    !hasDevices &&
    Date.now() - initialLoadStartedAtRef.current >= STABLE_FAILURE_EXPOSURE_MS &&
    Boolean(error ?? triggerDeviceError);
  const isLoading =
    loading ||
    triggerDeviceLoading ||
    (!shouldSurfaceStableFailure &&
      !hasDevices &&
      (!hasLoadedDevicesOnceRef.current || !hasLoadedTriggerDevicesOnceRef.current));
  const currentError = shouldSurfaceStableFailure ? error ?? triggerDeviceError : null;

  const areaOptions = useMemo(() => {
    const set = new Set<string>();
    const eligible = getTenantDashboardDevices(devices);
    for (const d of eligible) {
      const areaName = (d.displayAreaName ?? d.areaName ?? d.area ?? '').trim();
      if (areaName) set.add(areaName);
    }
    for (const remote of triggerDevices) {
      const areaName = (remote.displayAreaName ?? remote.areaName ?? remote.area ?? '').trim();
      if (areaName) set.add(areaName);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [devices, triggerDevices]);

  const resolvedSelectedArea = useMemo(() => {
    if (selectedArea === ALL_AREAS) return ALL_AREAS;
    return areaOptions.includes(selectedArea) ? selectedArea : ALL_AREAS;
  }, [areaOptions, selectedArea]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('tenantSelectedArea', resolvedSelectedArea);
    } catch (err) {
      console.warn('Unable to persist tenant area', err);
    }
  }, [resolvedSelectedArea]);

  const eligibleDevices = useMemo(
    () => getTenantDashboardDevices(devices).filter((device) => device.ownership !== 'pending_cleanup'),
    [devices]
  );

  const usersByArea: UsersByArea = useMemo(() => {
    if (!roster) return {};
    const map: UsersByArea = {};
    for (const user of roster.users) {
      for (const area of user.areas) {
        if (!map[area]) map[area] = [];
        map[area].push(user);
      }
    }
    return map;
  }, [roster]);

  const areaShareSummary: AreaShareSummary = useMemo(() => {
    const summary: AreaShareSummary = {};
    if (!roster) return summary;
    for (const area of roster.tenantAreas) {
      summary[area] = { otherTenants: 0, supportAgents: 0, homeowners: 0 };
    }
    for (const user of roster.users) {
      for (const area of user.areas) {
        if (!summary[area]) summary[area] = { otherTenants: 0, supportAgents: 0, homeowners: 0 };
        if (user.role === 'TENANT' && user.username !== username) {
          summary[area].otherTenants += 1;
        } else if (user.role === 'INSTALLER') {
          summary[area].supportAgents += 1;
        } else if (user.role === 'ADMIN') {
          summary[area].homeowners += 1;
        }
      }
    }
    return summary;
  }, [username, roster]);

  const visibleDevices = useMemo(
    () =>
      eligibleDevices.filter((d) => {
        const areaName = (d.displayAreaName ?? d.areaName ?? d.area ?? '').trim();
        if (
          resolvedSelectedArea !== ALL_AREAS &&
          areaName !== resolvedSelectedArea
        ) {
          return false;
        }
        return true;
      }),
    [eligibleDevices, resolvedSelectedArea]
  );

  const visibleTriggerDevices = useMemo(
    () =>
      (triggerDevices.length > 0 ? triggerDevices : previewTriggerDevices).filter((remote) => {
        const areaName = (remote.displayAreaName ?? remote.areaName ?? remote.area ?? '').trim();
        if (
          resolvedSelectedArea !== ALL_AREAS &&
          areaName !== resolvedSelectedArea
        ) {
          return false;
        }
        return true;
      }),
    [triggerDevices, previewTriggerDevices, resolvedSelectedArea]
  );

  const triggerDeviceIds = useMemo(
    () =>
      new Set(
        [
          ...Array.from(acceptedTriggerDeviceIds),
          ...(triggerDevices.length > 0 ? triggerDevices : previewTriggerDevices)
            .map((item) => item.deviceId ?? item.triggerDeviceId)
            .filter((value): value is string => Boolean(value)),
        ]
      ),
    [acceptedTriggerDeviceIds, triggerDevices, previewTriggerDevices]
  );

  const dashboardItemsByLabel = useMemo(() => {
    const map = new Map<string, DashboardTileItem[]>();
    visibleDevices.forEach((device) => {
      const identity = device.deviceId ?? device.entityId;
      if (triggerDeviceIds.has(identity)) return;
      const key = getGroupLabel(device);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ kind: 'device', id: `device:${device.entityId}`, device });
    });
    visibleTriggerDevices.forEach((triggerDevice) => {
      const key = getTriggerDeviceLabel(triggerDevice);
      if (!map.has(key)) map.set(key, []);
      map
        .get(key)!
        .push({ kind: 'trigger', id: `trigger:${triggerDevice.triggerDeviceId}`, triggerDevice });
    });
    return map;
  }, [triggerDeviceIds, visibleDevices, visibleTriggerDevices]);

  const sortedLabels = useMemo(
    () => sortLabels(Array.from(dashboardItemsByLabel.keys())),
    [dashboardItemsByLabel]
  );

  const openDevice = openDeviceId
    ? devices.find((d) => d.entityId === openDeviceId) ?? null
    : null;
  const openTriggerDevice = openTriggerDeviceId
    ? triggerDevices.find((remote) => remote.triggerDeviceId === openTriggerDeviceId) ?? null
    : null;

  const linkedSensors = useMemo(() => {
    if (!openDevice) return [];
    const targetGroupId = getDeviceGroupingId(openDevice);
    if (!targetGroupId) return [];
    return devices.filter(
      (candidate) =>
        candidate.entityId !== openDevice.entityId &&
        getDeviceGroupingId(candidate) === targetGroupId &&
        isSensorEntity(candidate)
    );
  }, [devices, openDevice]);

  const relatedDevices =
    openDevice && getGroupLabel(openDevice) === 'Home Security'
      ? devices.filter((d) => getGroupLabel(d) === 'Home Security')
      : undefined;

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface via-background to-surface-2 text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-3 pb-16 pt-10 sm:px-4 lg:pt-12">
        <header className="sticky top-4 z-30 flex flex-col gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-slate-600 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:rounded-full sm:px-6 sm:py-2.5">
          <div className="flex items-start gap-3 sm:items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/60 bg-white shadow-sm">
              <Image
                src="/brand/logo-mark.png"
                alt="Dinodia"
                width={40}
                height={40}
                priority
              />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.35em] text-slate-400">
                Dinodia Home
              </p>
              <div className="relative inline-block" ref={areaMenuRef}>
                <button
                  type="button"
                  onClick={() => setAreaMenuOpen((open) => !open)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm hover:bg-white"
                >
                  <span>
                    {resolvedSelectedArea === ALL_AREAS
                      ? 'My home'
                      : resolvedSelectedArea}
                  </span>
                  <span className="text-xs text-slate-500">▾</span>
                </button>
                {areaMenuOpen && (
                  <div className="absolute left-0 z-10 mt-2 w-56 rounded-xl border border-slate-100 bg-white/95 p-1 text-sm text-slate-700 shadow-lg backdrop-blur">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                      onClick={() => {
                        setSelectedArea(ALL_AREAS);
                        setAreaMenuOpen(false);
                      }}
                    >
                      <span>All my rooms</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {areaOptions.length}
                      </span>
                    </button>
                    {areaOptions.map((area) => (
                      <button
                        key={area}
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                        onClick={() => {
                          setSelectedArea(area);
                          setAreaMenuOpen(false);
                        }}
                      >
                        <span className="truncate">{area}</span>
                        <span className="flex items-center gap-1 text-[11px] font-medium">
                          {areaShareSummary[area]?.otherTenants ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                              Shared
                              {areaShareSummary[area].otherTenants > 1 && (
                                <span className="ml-1">
                                  +{areaShareSummary[area].otherTenants - 1}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                              Private
                            </span>
                          )}
                          {areaShareSummary[area]?.supportAgents ? (
                            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-700">
                              Support
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">Connected Devices</p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
            <div className="w-full text-left sm:min-w-[140px] sm:text-right">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                Today
              </p>
              <p>{clock}</p>
              {showAlexaLink && (
                <a
                  href={ALEXA_SKILL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm hover:bg-white"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
                    a
                  </span>
                  Alexa Link
                </a>
              )}
            </div>
            <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end sm:gap-3">
              <div className="relative hidden sm:block" ref={deviceMenuRef}>
                <button
                  type="button"
                  onClick={() => setDeviceMenuOpen((v) => !v)}
                  className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                >
                  + Device
                </button>
                {deviceMenuOpen && (
                  <div className="absolute right-0 mt-2 w-56 rounded-xl border border-slate-100 bg-white/95 p-1 text-sm text-slate-700 shadow-lg backdrop-blur">
                    <Link
                      href="/tenant/devices/discovered"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setDeviceMenuOpen(false)}
                    >
                      Autodiscovered devices
                    </Link>
                    <Link
                      href="/tenant/devices/add"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setDeviceMenuOpen(false)}
                    >
                      Matter devices
                    </Link>
                  </div>
                )}
              </div>
              <div className="flex h-9 w-9 items-center justify-center text-slate-400">
                {isLoading && (
                  <span
                    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500"
                    role="status"
                    aria-label="Refreshing devices"
                  />
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  aria-label="Access roster"
                  onClick={() => setAccessOpen(true)}
                  className="flex h-9 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-white"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-[13px] font-bold text-white">
                    👥
                  </span>
                  <span className="hidden sm:inline">Access</span>
                  {roster && roster.counts.uniqueOtherUsers > 0 && !rosterError && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-white shadow">
                      {roster.counts.uniqueOtherUsers}
                    </span>
                  )}
                </button>
              </div>
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  aria-label="Menu"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-slate-600 shadow-sm hover:bg-white"
                >
                  <span className="sr-only">Menu</span>
                  <span className="flex flex-col gap-1">
                    <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
                    <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
                    <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
                  </span>
                </button>
                {menuOpen && (
                  <div className="absolute right-0 mt-2 w-44 rounded-xl border border-slate-100 bg-white/95 p-1 text-sm text-slate-700 shadow-lg backdrop-blur">
                    <Link
                      href="/tenant/devices/add"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      Add Matter Device
                    </Link>
                    <Link
                      href="/tenant/devices/discovered"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      Add Discovered Device
                    </Link>
                    <Link
                      href="/tenant/settings"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      User Settings
                    </Link>
                    <Link
                      href="/tenant/automations"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      Home Automations
                    </Link>
                    <Link
                      href="/devices/manage"
                      className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      Manage Devices
                    </Link>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                      onClick={() => {
                        setMenuOpen(false);
                        void performLogout();
                      }}
                    >
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {currentError && !hasDevices && (
          <div className="rounded-3xl border border-red-100 bg-red-50/80 px-6 py-4 text-sm text-red-600 shadow-sm">
            {currentError}
          </div>
        )}
        {currentError && hasDevices && (
          <div className="flex items-center gap-2 rounded-2xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs text-amber-700 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            <span>{currentError}</span>
          </div>
        )}
        <div className="space-y-10">
          {sortedLabels.map((label) => {
            if (label === OTHER_LABEL) return null;
            const group = dashboardItemsByLabel.get(label);
            if (!group || group.length === 0) return null;
            return (
              <section key={label} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold tracking-tight">
                    {label}
                  </h2>
                </div>
                <div>
                  <div className="grid grid-cols-1 gap-3 justify-items-center sm:justify-items-stretch sm:gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                    {group.map((item) =>
                      item.kind === 'device' ? (
                        <DeviceTile
                          key={item.id}
                          device={item.device}
                          batteryPercent={item.device.batteryPercent ?? null}
                          onOpenDetails={() => setOpenDeviceId(item.device.entityId)}
                          onActionComplete={() => {
                            invalidateTenantInventorySnapshot();
                            void loadInventory({ silent: true, force: true });
                          }}
                        />
                      ) : (
                        <TriggerDeviceTile
                          key={item.id}
                          remote={item.triggerDevice}
                          onOpenDetails={() => setOpenTriggerDeviceId(item.triggerDevice.triggerDeviceId)}
                        />
                      )
                    )}
                  </div>
                </div>
              </section>
            );
          })}

          {isLoading && !hasDevices && (
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={`tenant-device-skeleton-${index}`} className="h-[160px] rounded-[24px]" />
              ))}
            </section>
          )}

          {sortedLabels.length === 0 && !isLoading && (
            <EmptyState
              title="No devices are visible yet"
              description="Ask the homeowner to confirm your area access, or add a discovered device to get started."
              actionLabel="Add discovered device"
              onAction={() => router.push('/tenant/devices/discovered')}
            />
          )}
        </div>
      </div>

      {openDevice && (
        <DeviceDetailSheet
          device={openDevice}
          onClose={() => setOpenDeviceId(null)}
          onActionComplete={() => {
            invalidateTenantInventorySnapshot();
            void loadInventory({ silent: true, force: true });
          }}
          relatedDevices={relatedDevices}
          linkedSensors={linkedSensors}
          showAdminControls={false}
          allowSensorHistory
          historyEndpoint="/api/tenant/monitoring/history"
        />
      )}
      {openTriggerDevice && (
        <TriggerDeviceDetailSheet
          remote={openTriggerDevice}
          targetOptions={triggerTargetOptions}
          canManageTenantDevice={openTriggerDevice.ownership === 'tenant_owned'}
          onClose={() => setOpenTriggerDeviceId(null)}
          onEditDevice={async () => {
            const currentName = (openTriggerDevice.displayName ?? openTriggerDevice.name).trim();
            const nextName = window.prompt('Device name', currentName)?.trim();
            if (!nextName || nextName === currentName) return;
            await platformFetchJson(
              `/api/tenant/devices/${encodeURIComponent(openTriggerDevice.deviceId ?? openTriggerDevice.entityId)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  displayName: nextName,
                  displayLabel: openTriggerDevice.displayLabel ?? openTriggerDevice.label ?? null,
                  parentAreaName:
                    openTriggerDevice.displayAreaName ?? openTriggerDevice.areaName ?? openTriggerDevice.area ?? null,
                }),
              },
              'We couldn’t update this device right now. Please try again.'
            );
            invalidateTenantInventorySnapshot();
            await loadInventory({ silent: true, force: true });
          }}
          onMoveDevice={async () => {
            const area = window.prompt(
              'Move device to area',
              (openTriggerDevice.displayAreaName ?? openTriggerDevice.areaName ?? openTriggerDevice.area ?? '').trim()
            )?.trim();
            if (!area) return;
            await platformFetchJson(
              `/api/tenant/devices/${encodeURIComponent(openTriggerDevice.deviceId ?? openTriggerDevice.entityId)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  displayName: openTriggerDevice.displayName ?? openTriggerDevice.name,
                  displayLabel: openTriggerDevice.displayLabel ?? openTriggerDevice.label ?? null,
                  parentAreaName: area,
                }),
              },
              'We couldn’t move this device right now. Please try again.'
            );
            invalidateTenantInventorySnapshot();
            await loadInventory({ silent: true, force: true });
          }}
          onDeleteDevice={async () => {
            const result = await platformFetchJson<TenantDeviceDeleteResult>(
              `/api/tenant/devices/${encodeURIComponent(openTriggerDevice.deviceId ?? openTriggerDevice.entityId)}`,
              { method: 'DELETE' },
              'We couldn’t delete this device right now. Please try again.'
            );
            setOpenTriggerDeviceId(null);
            invalidateTenantInventorySnapshot();
            await loadInventory({ silent: true, force: true });
            if (result.postDeleteNotice) {
              window.alert(result.postDeleteNotice);
            }
          }}
          onSaveTarget={async ({ targetDeviceId, targetEntityId }) => {
            const previousTriggerDevices = triggerDevices;
            const selectedTarget = triggerTargetOptions.find(
              (option) =>
                option.targetDeviceId === targetDeviceId && option.targetEntityId === targetEntityId
            );
            setTriggerDevices((prev) =>
              prev.map((remote) =>
                remote.triggerDeviceId !== openTriggerDevice.triggerDeviceId
                  ? remote
                  : {
                      ...remote,
                      target: selectedTarget
                        ? {
                            targetId: selectedTarget.optionId,
                            entityId: selectedTarget.targetEntityId,
                            deviceId: selectedTarget.targetDeviceId,
                            name: selectedTarget.deviceName,
                            domain: selectedTarget.domain,
                            areaName: selectedTarget.areaName ?? null,
                            label: selectedTarget.label,
                            labelCategory: selectedTarget.label,
                            state: selectedTarget.state,
                          }
                        : remote.target,
                      resolutionState: 'bound',
                    }
              )
            );
            const result = await platformFetchJson<{
              binding?: TriggerDeviceSummary['binding'];
              capability?: TriggerDeviceSummary['capability'];
              target?: TriggerDeviceSummary['target'];
              resolutionState?: TriggerDeviceSummary['resolutionState'];
              triggerDevice?: TriggerDeviceSummary | null;
              verified?: boolean;
            }>(
              `/api/trigger-devices/${encodeURIComponent(openTriggerDevice.triggerDeviceId)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  bindingId: openTriggerDevice.binding?.bindingId ?? null,
                  targetEntityId,
                  targetDeviceId,
                  bindingName: openTriggerDevice.binding?.bindingName ?? `${openTriggerDevice.name} control`,
                }),
              },
              'We couldn’t update this trigger device right now. Please try again.'
            ).catch((error) => {
              setTriggerDevices(previousTriggerDevices);
              throw error;
            });
            setTriggerDevices((prev) =>
              prev.map((remote) => {
                if (remote.triggerDeviceId !== openTriggerDevice.triggerDeviceId) return remote;
                if (result.verified && result.triggerDevice) {
                  return result.triggerDevice;
                }
                if (result.verified) {
                  return {
                    ...remote,
                    binding: result.binding ?? remote.binding,
                    capability: result.capability ?? remote.capability,
                    target: result.target ?? remote.target,
                    resolutionState: result.resolutionState ?? remote.resolutionState,
                  };
                }
                return {
                  ...remote,
                  binding: remote.binding,
                  capability: remote.capability,
                  target: remote.target,
                  resolutionState: remote.resolutionState,
                };
              })
            );
            invalidateTenantInventorySnapshot();
            window.setTimeout(() => {
              void loadInventory({ silent: true, force: true });
            }, 800);
          }}
        />
      )}
      <TenantAccessRosterDialog
        open={accessOpen}
        onClose={() => setAccessOpen(false)}
        roster={roster}
        loading={rosterLoading}
        error={rosterError}
        onRetry={() => void loadRoster()}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        usersByArea={usersByArea}
        areaShareSummary={areaShareSummary}
      />
    </div>
  );
}
