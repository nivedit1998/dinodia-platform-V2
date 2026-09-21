// Architecture: App Router surface src/app/admin/ui/AdminSettings.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { logout as performLogout } from '@/lib/logout';
import { platformFetch } from '@/lib/platformFetchClient';
import { friendlyUnknownError } from '@/lib/clientError';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

type Props = {
  username: string;
  mode?: 'full' | 'devices' | 'users';
};

type StatusMessage = { type: 'success' | 'error'; message: string } | null;
type TenantForm = { username: string; email: string; password: string; areas: string[] };
type TenantStringField = 'username' | 'email' | 'password';
type SellingMode = 'FULL_RESET' | 'OWNER_TRANSFER';
type PartialAreaBucket = {
  displayName: string;
  displayKey?: string | null;
  upgradeDisplayName?: string | null;
  upgradeDisplayKey?: string | null;
  coveredSourceAreaNames?: string[];
  missingSourceAreaNames?: string[];
  isPartial?: boolean;
};
type TenantInfo = {
  id: number;
  username: string;
  email: string | null;
  areas: string[];
  rawAreas?: string[];
  areaDisplayKeys?: string[];
  partialAreaBuckets?: PartialAreaBucket[];
};
type TenantActionState = { saving: boolean; error: string | null };
const OTHER_LABEL_ERROR = 'Label cannot be Other, please be more specific';
const isReservedOtherLabel = (value: string) => value.trim().toLowerCase() === 'other';
type DeviceOverride = {
  entityId: string;
  name: string;
  area?: string | null;
  label?: string | null;
  sourceAreaName?: string | null;
  sourceTechnicalLabel?: string | null;
  displayAreaName?: string | null;
  displayLabel?: string | null;
  linkedSensors?: {
    entityId: string;
    name: string;
    label?: string | null;
    unit?: string | null;
    lastCapturedAt?: string;
  }[];
  blindTravelSeconds?: number | null;
  boilerPowerKw?: number | null;
  heatingPricePerKwh?: number | null;
  boilerEfficiencyBand?: string | null;
};
type AdminAreaOption = {
  haAreaName: string;
  displayName: string;
  displayKey: string;
  hasOverride: boolean;
};
type AdminAreaBucket = {
  displayName: string;
  displayKey: string;
  sourceAreaNames: string[];
};
type AdminLabelOption = {
  sourceTechnicalLabel: string;
  canonicalLabel: string;
  displayName: string;
  displayKey: string;
  hasOverride: boolean;
};
type AdminLabelBucket = {
  displayName: string;
  displayKey: string;
  sourceTechnicalLabels: string[];
};
type OverrideForm = {
  entityId: string;
  name: string;
  area: string;
  label: string;
  blindTravelSeconds: string;
  boilerPowerKw: string;
  heatingPricePerKwh: string;
  boilerEfficiencyBand: string;
};
type SellingPreview = {
  fullReset?: {
    haTargets?: {
      tenantOwnedDeviceIds?: string[];
      tenantOwnedEntityIds?: string[];
      tenantAutomationIds?: string[];
    };
    dbCounts?: Record<string, number>;
  };
  ownerTransfer?: {
    dbCounts?: Record<string, number>;
  };
};

const EMPTY_TENANT_FORM: TenantForm = { username: '', email: '', password: '', areas: [] };
const EMPTY_PASSWORD_FORM = {
  currentPassword: '',
  newPassword: '',
  confirmNewPassword: '',
};
const IOS_APP_URL = 'https://apps.apple.com';
const ANDROID_APP_URL = 'https://play.google.com/store';
const KIOSK_URL = 'https://dinodiasmartliving.com/kiosk';
const TENANT_LOCKED_MESSAGE =
  'Remote access must be enabled before adding tenants from this portal. To add tenants without paying for remote access you will have to use your iOS/Android phone or the Dinodia Kiosk.';

export default function AdminSettings({ username, mode = 'full' }: Props) {
  const { pushToast } = useToast();
  const showProfile = mode === 'full';
  const showTenantSections = mode === 'users';
  const showOverrideSection = mode === 'devices';
  const showDeregister = mode === 'full';
  const [tenantForm, setTenantForm] = useState<TenantForm>(EMPTY_TENANT_FORM);
  const [tenantMsg, setTenantMsg] = useState<string | null>(null);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [areaOptions, setAreaOptions] = useState<AdminAreaOption[]>([]);
  const [areaBuckets, setAreaBuckets] = useState<AdminAreaBucket[]>([]);
  const [newAreaInput, setNewAreaInput] = useState('');
  const [viewTenantsOpen, setViewTenantsOpen] = useState(mode === 'users');
  const [addTenantOpen, setAddTenantOpen] = useState(mode === 'users');
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [tenantActions, setTenantActions] = useState<Record<number, TenantActionState>>({});
  const [tenantAreaInputs, setTenantAreaInputs] = useState<Record<number, string>>({});
  const [tenantToDelete, setTenantToDelete] = useState<TenantInfo | null>(null);
  const [tenantDeleteLoading, setTenantDeleteLoading] = useState(false);
  const [tenantDeleteError, setTenantDeleteError] = useState<string | null>(null);
  const cleanDisplay = useCallback((value: string) => value.replace(/^sensor\./i, '').replace(/_/g, ' '), []);
  const stringToColor = useCallback((str: string) => {
    let hash = 0;
    const input = str || 'Unassigned';
    for (let i = 0; i < input.length; i += 1) {
      hash = input.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    const bg = `hsla(${hue}, 60%, 90%, 1)`;
    const fg = `hsla(${hue}, 55%, 35%, 1)`;
    return { bg, fg };
  }, []);

  const [passwordForm, setPasswordForm] = useState(EMPTY_PASSWORD_FORM);
  const [passwordAlert, setPasswordAlert] = useState<StatusMessage>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{
    status: 'checking' | 'enabled' | 'disabled' | 'error';
    message: string | null;
  }>({ status: 'enabled', message: null });
  const [passwordSectionOpen, setPasswordSectionOpen] = useState(false);
  const [sellingModalOpen, setSellingModalOpen] = useState(false);
  const [sellingMode, setSellingMode] = useState<SellingMode | null>(null);
  const [sellingLoading, setSellingLoading] = useState(false);
  const [sellingError, setSellingError] = useState<string | null>(null);
  const [sellingClaimCode, setSellingClaimCode] = useState<string | null>(null);
  const [claimCopyStatus, setClaimCopyStatus] = useState<string | null>(null);
  const [sellingPreview, setSellingPreview] = useState<SellingPreview | null>(null);
  const [sellingPreviewLoading, setSellingPreviewLoading] = useState(false);

  const [propertyManagerEmail, setPropertyManagerEmail] = useState('');
  const [propertyManagerLoading, setPropertyManagerLoading] = useState(false);
  const [propertyManagerMsg, setPropertyManagerMsg] = useState<StatusMessage>(null);

  const [overrides, setOverrides] = useState<DeviceOverride[]>([]);
  const [labelOptions, setLabelOptions] = useState<AdminLabelOption[]>([]);
  const [labelBuckets, setLabelBuckets] = useState<AdminLabelBucket[]>([]);
  const [editingArea, setEditingArea] = useState<AdminAreaOption | null>(null);
  const [editingLabel, setEditingLabel] = useState<AdminLabelOption | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [overrideAlert, setOverrideAlert] = useState<StatusMessage>(null);
  const [overrideForm, setOverrideForm] = useState<OverrideForm>({
    entityId: '',
    name: '',
    area: '',
    label: '',
    blindTravelSeconds: '',
    boilerPowerKw: '',
    heatingPricePerKwh: '',
    boilerEfficiencyBand: '',
  });
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [filterAreas, setFilterAreas] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [areaMenuOpen, setAreaMenuOpen] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const areaMenuRef = useRef<HTMLDivElement | null>(null);
  const labelMenuRef = useRef<HTMLDivElement | null>(null);
  const visibleLabelOptions = useMemo(
    () => labelOptions.filter((label) => label.sourceTechnicalLabel.trim().toLowerCase() !== 'other'),
    [labelOptions]
  );
  const areaBucketKey = useCallback(
    (bucket: { displayKey?: string | null; displayName: string }) => {
      const trimmedKey = bucket.displayKey?.trim();
      if (trimmedKey) return trimmedKey;
      return bucket.displayName.trim();
    },
    []
  );
  const areaBucketLabelByKey = useMemo(
    () =>
      new Map(
        areaBuckets.map((bucket) => [areaBucketKey(bucket), bucket.displayName] as const)
      ),
    [areaBuckets, areaBucketKey]
  );
  const areaLabelForValue = useCallback(
    (value: string) => areaBucketLabelByKey.get(value.trim()) ?? value.trim(),
    [areaBucketLabelByKey]
  );
  const selectedTenantAreaKeys = useCallback(
    (tenant: TenantInfo) => {
      if (Array.isArray(tenant.areaDisplayKeys) && tenant.areaDisplayKeys.length > 0) {
        return tenant.areaDisplayKeys;
      }
      return tenant.areas;
    },
    []
  );
  const normalizeTenant = useCallback(
    (tenant: {
      id: number | string;
      username?: unknown;
      email?: unknown;
      areas?: unknown;
      rawAreas?: unknown;
      areaDisplayKeys?: unknown;
      partialAreaBuckets?: unknown;
    }): TenantInfo | null => {
      const id = typeof tenant.id === 'number' ? tenant.id : Number(tenant.id);
      const username = typeof tenant.username === 'string' ? tenant.username : '';
      if (!Number.isFinite(id) || username.length === 0) return null;
      const cleanStringArray = (value: unknown) =>
        Array.isArray(value)
          ? value
              .filter((entry: unknown): entry is string => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter(Boolean)
          : [];
      const partialAreaBuckets = Array.isArray(tenant.partialAreaBuckets)
        ? tenant.partialAreaBuckets
            .filter((entry): entry is PartialAreaBucket => Boolean(entry && typeof entry === 'object'))
            .map((entry) => ({
              displayName: typeof entry.displayName === 'string' ? entry.displayName.trim() : '',
              displayKey: typeof entry.displayKey === 'string' ? entry.displayKey.trim() : null,
              upgradeDisplayName:
                typeof entry.upgradeDisplayName === 'string' ? entry.upgradeDisplayName.trim() : null,
              upgradeDisplayKey:
                typeof entry.upgradeDisplayKey === 'string' ? entry.upgradeDisplayKey.trim() : null,
              coveredSourceAreaNames: cleanStringArray(entry.coveredSourceAreaNames),
              missingSourceAreaNames: cleanStringArray(entry.missingSourceAreaNames),
              isPartial: entry.isPartial === true,
            }))
            .filter((entry) => entry.displayName.length > 0)
        : [];
      return {
        id,
        username,
        email: typeof tenant.email === 'string' && tenant.email.trim().length > 0 ? tenant.email.trim() : null,
        areas: cleanStringArray(tenant.areas),
        rawAreas: cleanStringArray(tenant.rawAreas),
        areaDisplayKeys: cleanStringArray(tenant.areaDisplayKeys),
        partialAreaBuckets,
      };
    },
    []
  );

  const visibleOverrides = useMemo(() => {
    return overrides.filter((ov) => {
      const lblRaw = (ov.displayLabel ?? ov.label)?.trim();
      const lbl = lblRaw ? lblRaw.toLowerCase() : '';
      if (!lbl || lbl === '-' || lbl === 'other') return false;
      const areaVal = (ov.displayAreaName ?? ov.area ?? '').trim().toLowerCase();
      if (!areaVal || areaVal === 'unassigned') return false;
      if (filterAreas.length && !filterAreas.includes(ov.displayAreaName || ov.area || '')) return false;
      if (filterLabels.length && !filterLabels.map((l) => l.toLowerCase()).includes(lbl)) return false;
      return true;
    });
  }, [overrides, filterAreas, filterLabels]);

  useEffect(() => {
    function handleClickOutside(evt: MouseEvent) {
      const target = evt.target as Node;
      if (areaMenuRef.current && !areaMenuRef.current.contains(target)) setAreaMenuOpen(false);
      if (labelMenuRef.current && !labelMenuRef.current.contains(target)) setLabelMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function updateTenantField(key: TenantStringField, value: string) {
    setTenantForm((prev) => ({ ...prev, [key]: value }));
  }

  const loadPropertyManager = useCallback(async () => {
    try {
      const res = await platformFetch('/api/admin/home/contacts', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const email = typeof data.propertyManagerEmail === 'string' ? data.propertyManagerEmail : '';
      setPropertyManagerEmail(email || '');
    } catch {
      // best effort
    }
  }, []);

  function updatePasswordField(key: keyof typeof passwordForm, value: string) {
    setPasswordForm((prev) => ({ ...prev, [key]: value }));
  }

  const loadAvailableAreas = useCallback(async () => {
    try {
      const res = await platformFetch('/api/admin/areas', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error('Failed to load areas.');
      }
      const options: AdminAreaOption[] = Array.isArray(data.areaOptions) ? data.areaOptions : [];
      const buckets: AdminAreaBucket[] = Array.isArray(data.areaBuckets) ? data.areaBuckets : [];
      setAreaOptions(options);
      setAreaBuckets(buckets);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Unable to load area suggestions', err);
      }
    }
  }, []);

  useEffect(() => {
    void loadAvailableAreas();
  }, [loadAvailableAreas]);

  useEffect(() => {
    void loadPropertyManager();
  }, [loadPropertyManager]);

  function addArea(areaValue?: string) {
    const valueToUse = areaValue ?? newAreaInput;
    const trimmed = valueToUse.trim();
    if (!trimmed) return;
    setTenantForm((prev) => {
      if (prev.areas.includes(trimmed)) return prev;
      return { ...prev, areas: [...prev.areas, trimmed] };
    });
    setNewAreaInput('');
  }

  function removeArea(areaValue: string) {
    setTenantForm((prev) => ({
      ...prev,
      areas: prev.areas.filter((area) => area !== areaValue),
    }));
  }

  const refreshRemoteStatus = useCallback(async () => {
    setRemoteStatus({ status: 'enabled', message: null });
  }, []);

  useEffect(() => {
    void refreshRemoteStatus();
  }, [refreshRemoteStatus]);

  const loadOverrides = useCallback(async () => {
    setOverrideAlert(null);
    try {
      const params = new URLSearchParams();
      params.set('days', '90');
      const res = await platformFetch(
        `/api/admin/device-overrides${params.toString() ? `?${params.toString()}` : ''}`,
        { cache: 'no-store' }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to load device settings.');
      }
      setOverrides(Array.isArray(data.devices) ? data.devices : []);
      if (Array.isArray(data.areaOptions)) setAreaOptions(data.areaOptions);
      if (Array.isArray(data.areaBuckets)) {
        setAreaBuckets(data.areaBuckets);
      }
      if (Array.isArray(data.labelOptions)) setLabelOptions(data.labelOptions);
      if (Array.isArray(data.labelBuckets)) setLabelBuckets(data.labelBuckets);
    } catch (err) {
      setOverrideAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'Unsuccessful - unable to load device settings.'),
      });
    }
  }, []);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  function startNewOverride(entityId = '') {
    setEditingOverrideId(null);
    setOverrideForm({
      entityId,
      name: cleanDisplay(entityId),
      area: '',
      label: '',
      blindTravelSeconds: '',
      boilerPowerKw: '',
      heatingPricePerKwh: '',
      boilerEfficiencyBand: '',
    });
  }

  function startEditOverride(override: DeviceOverride) {
    setEditingOverrideId(override.entityId);
    setOverrideForm({
      entityId: override.entityId,
      name: override.name || override.label || cleanDisplay(override.entityId),
      area: override.sourceAreaName ?? override.area ?? '',
      label: override.sourceTechnicalLabel ?? override.label ?? '',
      blindTravelSeconds:
        override.blindTravelSeconds != null ? String(override.blindTravelSeconds) : '',
      boilerPowerKw: override.boilerPowerKw != null ? String(override.boilerPowerKw) : '',
      heatingPricePerKwh: override.heatingPricePerKwh != null ? String(override.heatingPricePerKwh) : '',
      boilerEfficiencyBand: override.boilerEfficiencyBand != null ? String(override.boilerEfficiencyBand) : '',
    });
  }

  async function saveOverride() {
    setOverrideAlert(null);
    const entityId = overrideForm.entityId.trim();
    const name = (overrideForm.name || entityId).trim();
    if (!entityId || !name) {
      setOverrideAlert({ type: 'error', message: 'Entity ID and name are required.' });
      return;
    }

    let blindTravelSeconds: number | null = null;
    const blindRaw = overrideForm.blindTravelSeconds.trim();
    if (blindRaw) {
      const parsed = Number(blindRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setOverrideAlert({
          type: 'error',
          message: 'Blind travel time must be a positive number of seconds.',
        });
        return;
      }
      blindTravelSeconds = parsed;
    }

    const labelKey = overrideForm.label.trim().toLowerCase();
    if (isReservedOtherLabel(overrideForm.label)) {
      setOverrideAlert({
        type: 'error',
        message: OTHER_LABEL_ERROR,
      });
      return;
    }
    let boilerPowerKw: number | null | undefined = undefined;
    let heatingPricePerKwh: number | null | undefined = undefined;
    let boilerEfficiencyBand: string | null | undefined = undefined;

    if (labelKey === 'boiler') {
      const powerRaw = overrideForm.boilerPowerKw.trim();
      if (!powerRaw) {
        boilerPowerKw = null;
      } else {
        const parsed = Number(powerRaw);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 200) {
          setOverrideAlert({
            type: 'error',
            message: 'Boiler power (kW) must be a positive number (max 200) when provided.',
          });
          return;
        }
        boilerPowerKw = parsed;
      }

      const priceRaw = overrideForm.heatingPricePerKwh.trim();
      if (!priceRaw) {
        heatingPricePerKwh = null;
      } else {
        const parsed = Number(priceRaw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          setOverrideAlert({
            type: 'error',
            message: 'Heating price per kWh must be a non-negative number (max 100) when provided.',
          });
          return;
        }
        heatingPricePerKwh = parsed;
      }

      const bandRaw = overrideForm.boilerEfficiencyBand.trim();
      if (!bandRaw) {
        boilerEfficiencyBand = null;
      } else {
        const band = bandRaw.toUpperCase();
        if (!/^[A-G]$/.test(band)) {
          setOverrideAlert({
            type: 'error',
            message: 'Boiler efficiency band must be one of A, B, C, D, E, F, G when provided.',
          });
          return;
        }
        boilerEfficiencyBand = band;
      }
    } else if (editingOverrideId) {
      // If changing away from Boiler, clear any prior boiler overrides.
      boilerPowerKw = null;
      heatingPricePerKwh = null;
      boilerEfficiencyBand = null;
    }

    try {
      const res = await platformFetch('/api/admin/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId,
          name,
          area: overrideForm.area.trim(),
          label: overrideForm.label.trim(),
          blindTravelSeconds,
          ...(boilerPowerKw !== undefined ? { boilerPowerKw } : {}),
          ...(heatingPricePerKwh !== undefined ? { heatingPricePerKwh } : {}),
          ...(boilerEfficiencyBand !== undefined ? { boilerEfficiencyBand } : {}),
        }),
      });
      await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to save device settings.');
      }
      setOverrideAlert({ type: 'success', message: 'Device override saved.' });
      pushToast({
        kind: 'success',
        title: 'Device settings saved',
        message: 'Done - everything looks good.',
      });
      startNewOverride('');
      void loadOverrides();
      void loadAvailableAreas();
    } catch (err) {
      setOverrideAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'Unsuccessful - unable to save device settings.'),
      });
    }
  }

  const getAreaOptionLabel = useCallback(
    (option: AdminAreaOption) => {
      const duplicate = areaOptions.filter((candidate) => candidate.displayName === option.displayName).length > 1;
      return duplicate ? `${option.displayName} (Original: ${option.haAreaName})` : option.displayName;
    },
    [areaOptions]
  );

  const getLabelOptionLabel = useCallback(
    (option: AdminLabelOption) => {
      const duplicate = visibleLabelOptions.filter((candidate) => candidate.displayName === option.displayName).length > 1;
      return duplicate ? `${option.displayName} (Original: ${option.sourceTechnicalLabel})` : option.displayName;
    },
    [visibleLabelOptions]
  );

  async function saveAreaDisplayName() {
    if (!editingArea) return;
    const displayName = displayNameDraft.trim();
    if (!displayName) {
      setOverrideAlert({ type: 'error', message: 'Area name is required.' });
      return;
    }
    const conflict = areaOptions.find(
      (option) =>
        option.haAreaName !== editingArea.haAreaName &&
        option.displayName.trim().toLowerCase() === displayName.toLowerCase()
    );
    if (conflict) {
      const ok = window.confirm(
        `Are you sure? ${displayName} tenants will now have access to ${editingArea.haAreaName} devices and ${editingArea.displayName} tenants will lose access to ${editingArea.displayName} devices.`
      );
      if (!ok) return;
    }
    try {
      const res = await platformFetch('/api/admin/areas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ haAreaName: editingArea.haAreaName, displayName }),
      });
      if (!res.ok) throw new Error('Unsuccessful - unable to save area name.');
      setEditingArea(null);
      setDisplayNameDraft('');
      setOverrideAlert({ type: 'success', message: 'Area name saved.' });
      void loadAvailableAreas();
      void loadOverrides();
    } catch (err) {
      setOverrideAlert({ type: 'error', message: friendlyUnknownError(err, 'Unsuccessful - unable to save area name.') });
    }
  }

  async function saveLabelDisplayName() {
    if (!editingLabel) return;
    const displayName = displayNameDraft.trim();
    if (!displayName) {
      setOverrideAlert({ type: 'error', message: 'Label name is required.' });
      return;
    }
    try {
      const res = await platformFetch('/api/admin/label-display-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTechnicalLabel: editingLabel.sourceTechnicalLabel,
          canonicalLabel: editingLabel.canonicalLabel,
          displayName,
        }),
      });
      if (!res.ok) throw new Error('Unsuccessful - unable to save label name.');
      setEditingLabel(null);
      setDisplayNameDraft('');
      setOverrideAlert({ type: 'success', message: 'Label name saved.' });
      void loadOverrides();
    } catch (err) {
      setOverrideAlert({ type: 'error', message: friendlyUnknownError(err, 'Unsuccessful - unable to save label name.') });
    }
  }

  async function resetAreasToOriginal() {
    if (!window.confirm('Reset all area names to original? Tenant access and dashboards will update immediately.')) return;
    try {
      const res = await platformFetch('/api/admin/areas', { method: 'DELETE' });
      if (!res.ok) throw new Error('Unsuccessful - unable to reset areas.');
      setFilterAreas([]);
      setOverrideAlert({ type: 'success', message: 'Areas reset to original.' });
      void loadAvailableAreas();
      void loadOverrides();
    } catch (err) {
      setOverrideAlert({ type: 'error', message: friendlyUnknownError(err, 'Unsuccessful - unable to reset areas.') });
    }
  }

  async function resetLabelsToOriginal() {
    if (!window.confirm('Reset all label names to original?')) return;
    try {
      const res = await platformFetch('/api/admin/label-display-overrides', { method: 'DELETE' });
      if (!res.ok) throw new Error('Unsuccessful - unable to reset labels.');
      setFilterLabels([]);
      setOverrideAlert({ type: 'success', message: 'Labels reset to original.' });
      void loadOverrides();
    } catch (err) {
      setOverrideAlert({ type: 'error', message: friendlyUnknownError(err, 'Unsuccessful - unable to reset labels.') });
    }
  }

  async function resetDevicesToOriginal() {
    if (!window.confirm('Reset all device name, area, and label overrides to original? Blind and boiler calibration values will be kept.')) return;
    try {
      const res = await platformFetch('/api/admin/device', { method: 'DELETE' });
      if (!res.ok) throw new Error('Unsuccessful - unable to reset devices.');
      setOverrideAlert({ type: 'success', message: 'Devices reset to original.' });
      setEditingOverrideId(null);
      void loadOverrides();
    } catch (err) {
      setOverrideAlert({ type: 'error', message: friendlyUnknownError(err, 'Unsuccessful - unable to reset devices.') });
    }
  }

  async function handleTenantSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTenantMsg(null);

    if (tenantLocked) {
      setTenantMsg('Remote access must be enabled to add tenants from this portal.');
      return;
    }

    if (tenantForm.areas.length === 0) {
      setTenantMsg('Please add at least one area for this tenant.');
      return;
    }

    setTenantLoading(true);

    try {
      const res = await platformFetch('/api/admin/tenant', {
        method: 'POST',
        body: JSON.stringify({
          username: tenantForm.username,
          email: tenantForm.email,
          password: tenantForm.password,
          areas: tenantForm.areas,
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      await res.json();

      if (!res.ok) {
        setTenantMsg(
          'We couldn’t create this tenant right now. Please try again.'
        );
        return;
      }

      setTenantMsg('Tenant created successfully');
      pushToast({
        kind: 'success',
        title: 'Tenant added',
        message: 'Access has been updated for this home.',
      });
      setTenantForm(EMPTY_TENANT_FORM);
      setNewAreaInput('');
      if (viewTenantsOpen && !tenantLocked) {
        void fetchTenants();
      }
    } catch (err) {
      console.error('Failed to create tenant', err);
      setTenantMsg('We couldn’t create this tenant right now. Please try again.');
    } finally {
      setTenantLoading(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPasswordAlert(null);

    if (passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      setPasswordAlert({ type: 'error', message: 'New passwords do not match.' });
      return;
    }

    setPasswordLoading(true);
    try {
      const res = await platformFetch('/api/admin/profile/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(passwordForm),
      });
      await res.json();
      if (!res.ok) {
        throw new Error(
          'We couldn’t update your password right now. Please try again.'
        );
      }
      setPasswordAlert({ type: 'success', message: 'Password updated successfully.' });
      pushToast({
        kind: 'success',
        title: 'Password updated',
        message: 'Your account is all set.',
      });
      setPasswordForm(EMPTY_PASSWORD_FORM);
    } catch (err) {
      setPasswordAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'We couldn’t update your password right now. Please try again.'),
      });
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleLogout() {
    await performLogout();
  }

  function openSellingModal() {
    setSellingModalOpen(true);
    setSellingError(null);
    setClaimCopyStatus(null);
    if (!sellingClaimCode) {
      setSellingMode(null);
    }
  }

  const loadSellingPreview = useCallback(async () => {
    setSellingPreviewLoading(true);
    try {
      const res = await platformFetch('/api/admin/selling-property', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to load deregister impact preview.');
      }
      setSellingPreview({
        fullReset: data.fullReset,
        ownerTransfer: data.ownerTransfer,
      });
    } catch (err) {
      setSellingError(
        friendlyUnknownError(err, 'We couldn’t load the deregister impact preview. Please try again.')
      );
    } finally {
      setSellingPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showDeregister) return;
    void loadSellingPreview();
  }, [showDeregister, loadSellingPreview]);

  useEffect(() => {
    if (!showDeregister) return;
    const syncKey = 'dinodia_admin_automation_sync_once_v1';
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(syncKey) === 'done') return;
    void (async () => {
      try {
        await platformFetch('/api/admin/automations/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Automation sync backfill call failed', err);
        }
      } finally {
        window.localStorage.setItem(syncKey, 'done');
      }
    })();
  }, [showDeregister]);

  function closeSellingModal() {
    setSellingModalOpen(false);
    setSellingError(null);
    setClaimCopyStatus(null);
    if (!sellingClaimCode) {
      setSellingMode(null);
    }
  }

  function selectSellingMode(mode: SellingMode) {
    setSellingMode(mode);
    setSellingError(null);
  }

  async function confirmSellingSelection(mode: SellingMode) {
    if (sellingClaimCode) return;
    setSellingLoading(true);
    setSellingError(null);
    try {
      const res = await platformFetch('/api/admin/selling-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          'We couldn’t process this request. Please try again.'
        );
      }
      if (mode === 'OWNER_TRANSFER') {
        if (!data.claimCode || typeof data.claimCode !== 'string') {
          throw new Error('We could not retrieve the claim code. Please try again.');
        }
        const claimCode = data.claimCode;
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('dinodia_owner_transfer_claim_code_v1', claimCode);
            window.localStorage.setItem('dinodia_owner_transfer_claim_code_at_v1', new Date().toISOString());
          }
        } catch {
          // best-effort; modal still shows the claim code.
        }
        setSellingClaimCode(claimCode);
        setSellingMode(mode);
        // This flow deletes the current homeowner user, so the session may become invalid immediately after.
        // Redirect to a public page that can still display the claim code even if the user gets logged out.
        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            window.location.href = '/transfer/claim-code';
          }, 250);
        }
      } else {
        // FULL_RESET: no claim code, sign out after success.
        setSellingMode(null);
        setSellingClaimCode(null);
        await performLogout();
      }
    } catch (err) {
      setSellingError(
        friendlyUnknownError(err, 'We couldn’t process this request. Please try again.')
      );
    } finally {
      setSellingLoading(false);
    }
  }

  async function copyClaimCode() {
    if (!sellingClaimCode) return;
    try {
      await navigator.clipboard.writeText(sellingClaimCode);
      setClaimCopyStatus('Copied');
      pushToast({
        kind: 'success',
        title: 'Claim code copied',
        message: 'You can now share it with the incoming homeowner.',
      });
    } catch (err) {
      setClaimCopyStatus('Unsuccessful');
      pushToast({
        kind: 'warning',
        title: 'Unsuccessful',
        message: 'Please copy the claim code manually.',
      });
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Clipboard copy failed', err);
      }
    } finally {
      setTimeout(() => setClaimCopyStatus(null), 2000);
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
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

  const remoteStatusToneClass =
    remoteStatus.status === 'enabled'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : remoteStatus.status === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : remoteStatus.status === 'checking'
      ? 'border-slate-200 bg-slate-50 text-slate-600'
      : 'border-amber-200 bg-amber-50 text-amber-700';

  const remoteStatusCopy =
    remoteStatus.status === 'enabled'
      ? 'Cloud access is configured for this home.'
      : 'Cloud access status unknown.';
  const remoteAccessEnabled = remoteStatus.status === 'enabled';
  const tenantLocked = !remoteAccessEnabled;
  const deregisterLocked = !remoteAccessEnabled;
  const showRemoteActions = false;

  function updateTenantActionState(tenantId: number, updates: Partial<TenantActionState>) {
    setTenantActions((prev) => ({
      ...prev,
      [tenantId]: { ...(prev[tenantId] ?? { saving: false, error: null }), ...updates },
    }));
  }

  const fetchTenants = useCallback(async () => {
    if (tenantLocked) return;
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      const res = await platformFetch('/api/admin/tenant', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to load tenants.');
      }
      const list: TenantInfo[] = Array.isArray(data.tenants)
        ? (data.tenants as Array<{
            id: number | string;
            username?: unknown;
            email?: unknown;
            areas?: unknown;
            rawAreas?: unknown;
            areaDisplayKeys?: unknown;
            partialAreaBuckets?: unknown;
          }>)
            .map((tenant) => normalizeTenant(tenant))
            .filter((tenant: TenantInfo | null): tenant is TenantInfo => tenant !== null)
        : [];
      setTenants(list);
      setTenantAreaInputs((prev) => {
        const next: Record<number, string> = {};
        list.forEach((tenant) => {
          next[tenant.id] = prev[tenant.id] ?? '';
        });
        return next;
      });
    } catch (err) {
      setTenantsError(
        friendlyUnknownError(err, 'Unsuccessful - unable to load tenants. Please try again.')
      );
    } finally {
      setTenantsLoading(false);
    }
  }, [normalizeTenant, tenantLocked]);

  useEffect(() => {
    if (!viewTenantsOpen || tenantLocked) return;
    void fetchTenants();
  }, [viewTenantsOpen, tenantLocked, fetchTenants]);

  async function saveTenantAreas(tenantId: number, nextAreas: string[]) {
    updateTenantActionState(tenantId, { saving: true, error: null });
    try {
      const res = await platformFetch(`/api/admin/tenant/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ areas: nextAreas }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to update tenant access.');
      }
      const updatedTenant = data?.tenant ? normalizeTenant(data.tenant) : null;
      setTenants((prev) =>
        prev.map((tenant) =>
          tenant.id === tenantId
            ? updatedTenant ?? { ...tenant, areas: nextAreas, areaDisplayKeys: nextAreas }
            : tenant
        )
      );
      pushToast({
        kind: 'success',
        title: 'Tenant access updated',
        message: 'Area permissions were saved.',
      });
      setTenantAreaInputs((prev) => ({ ...prev, [tenantId]: '' }));
      updateTenantActionState(tenantId, { saving: false, error: null });
    } catch (err) {
      updateTenantActionState(tenantId, {
        saving: false,
        error: friendlyUnknownError(err, 'Unsuccessful - unable to update tenant access.'),
      });
    }
  }

  function handleRemoveTenantArea(tenantId: number, areaValue: string) {
    const target = tenants.find((tenant) => tenant.id === tenantId);
    if (!target) return;
    const nextAreas = selectedTenantAreaKeys(target).filter((area) => area !== areaValue);
    void saveTenantAreas(tenantId, nextAreas);
  }

  function handleAddTenantArea(tenantId: number) {
    const target = tenants.find((tenant) => tenant.id === tenantId);
    if (!target) return;
    const candidate = (tenantAreaInputs[tenantId] ?? '').trim();
    const currentAreas = selectedTenantAreaKeys(target);
    if (!candidate || currentAreas.includes(candidate)) return;
    const nextAreas = [...currentAreas, candidate];
    void saveTenantAreas(tenantId, nextAreas);
  }

  function handleUpgradePartialTenantArea(tenantId: number, displayKey: string) {
    const target = tenants.find((tenant) => tenant.id === tenantId);
    if (!target) return;
    const currentAreas = selectedTenantAreaKeys(target);
    if (currentAreas.includes(displayKey)) return;
    void saveTenantAreas(tenantId, [...currentAreas, displayKey]);
  }

  function openTenantDelete(tenant: TenantInfo) {
    setTenantToDelete(tenant);
    setTenantDeleteError(null);
  }

  async function confirmDeleteTenant() {
    if (!tenantToDelete) return;
    const targetId = tenantToDelete.id;
    setTenantDeleteLoading(true);
    setTenantDeleteError(null);
    try {
      const res = await platformFetch(`/api/admin/tenant/${targetId}`, { method: 'DELETE' });
      await res.json();
      if (!res.ok) {
        throw new Error('Unsuccessful - unable to remove tenant access.');
      }
      setTenants((prev) => prev.filter((tenant) => tenant.id !== targetId));
      setTenantActions((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setTenantAreaInputs((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setTenantToDelete(null);
      pushToast({
        kind: 'success',
        title: 'Tenant removed',
        message: 'Access has been removed from this home.',
      });
    } catch (err) {
      setTenantDeleteError(
        friendlyUnknownError(err, 'Unsuccessful - unable to remove tenant access. Please try again.')
      );
    } finally {
      setTenantDeleteLoading(false);
    }
  }

  const pageTitle =
    mode === 'devices'
      ? 'Configuration'
      : mode === 'users'
        ? 'User Management'
        : 'Account Settings';

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-slate-900">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-3 pb-16 pt-8 sm:px-4 lg:pt-12">
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
              <p className="text-[10px] uppercase tracking-[0.35em] text-slate-400">Admin</p>
              <p className="text-base font-semibold text-slate-900">{pageTitle}</p>
              <p className="text-[11px] text-slate-500">
                Signed in as <span className="font-medium">{username}</span>
              </p>
            </div>
          </div>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-label="Menu"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-slate-600 shadow-sm hover:bg-white"
            >
              <span className="sr-only">Menu</span>
              <span className="flex flex-col gap-1">
                <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
                <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
                <span className="block h-0.5 w-5 rounded-full bg-slate-500" />
              </span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-xl border border-slate-100 bg-white/95 p-1 text-sm text-slate-700 shadow-lg backdrop-blur">
                <Link
                  href="/admin/dashboard"
                  className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setMenuOpen(false)}
                >
                  Homeowner Dashboard
                </Link>
                <Link
                  href="/admin/settings"
                  className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setMenuOpen(false)}
                >
                  Account Settings
                </Link>
                <Link
                  href="/admin/manage-devices"
                  className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setMenuOpen(false)}
                >
                  Configuration
                </Link>
                <Link
                  href="/admin/manage-users"
                  className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                  onClick={() => setMenuOpen(false)}
                >
                  User Management
                </Link>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleLogout();
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200/70 bg-white/90 p-5 shadow-sm backdrop-blur lg:p-6">
          <div className="grid gap-5 text-sm lg:grid-cols-2">
        {showProfile && (
          <div className="border border-slate-200 rounded-xl p-4 lg:col-span-2">
            <h2 className="font-semibold mb-4">Profile</h2>
            <div className="space-y-6">
            <div className="rounded-xl border border-slate-200/60">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500"
                onClick={() => setPasswordSectionOpen((prev) => !prev)}
              >
                <span>Change password</span>
                <span className="text-[11px] font-normal text-slate-400">
                  {passwordSectionOpen ? 'Hide' : 'Show'}
                </span>
              </button>
              {passwordSectionOpen && (
                <div className="px-4 pb-4 pt-1 border-t border-slate-100">
                  <form onSubmit={handlePasswordSubmit} className="mt-3 space-y-3">
                    <div>
                      <label className="block mb-1 text-xs">Current password</label>
                      <input
                        type="password"
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={passwordForm.currentPassword}
                        onChange={(e) => updatePasswordField('currentPassword', e.target.value)}
                        required
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <label className="block mb-1 text-xs">New password</label>
                        <input
                          type="password"
                          className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                          value={passwordForm.newPassword}
                          onChange={(e) => updatePasswordField('newPassword', e.target.value)}
                          required
                          minLength={8}
                        />
                      </div>
                      <div>
                        <label className="block mb-1 text-xs">Confirm new password</label>
                        <input
                          type="password"
                          className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                          value={passwordForm.confirmNewPassword}
                          onChange={(e) =>
                            updatePasswordField('confirmNewPassword', e.target.value)
                          }
                          required
                          minLength={8}
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Minimum 8 characters. Use a unique passphrase for security.
                    </p>
                    <button
                      type="submit"
                      disabled={passwordLoading}
                      className="bg-indigo-600 text-white rounded-lg py-2 px-4 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {passwordLoading ? 'Updating…' : 'Update password'}
                    </button>
                  </form>
                  {passwordAlert && (
                    <p
                      className={`mt-2 text-xs ${
                        passwordAlert.type === 'success'
                          ? 'text-emerald-600'
                          : 'text-red-600'
                      }`}
                    >
                      {passwordAlert.message}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase text-slate-500">
                Remote access
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Remote access is managed from the mobile app or Dinodia Kiosk. This admin portal is
                observe-only; tenant control continues to use the existing mobile/Kiosk flows.
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Use the apps or Kiosk to change remote connectivity; this page only checks status.
              </p>
              <div
                className={`mt-3 rounded-lg border px-4 py-3 text-xs ${remoteStatusToneClass}`}
              >
                <p className="font-medium">{remoteStatusCopy}</p>
                {showRemoteActions && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <a
                      href={IOS_APP_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50"
                    >
                      Download on iOS
                    </a>
                    <a
                      href={ANDROID_APP_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50"
                    >
                      Get it on Android
                    </a>
                    <a
                      href={KIOSK_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center rounded-2xl border border-slate-200 bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800"
                    >
                      Purchase Dinodia Kiosk
                    </a>
                  </div>
                )}
                {remoteStatus.status !== 'checking' && (
                  <button
                    type="button"
                    className="mt-3 inline-flex items-center gap-1 rounded-full border border-current px-3 py-1 text-[11px] font-medium hover:bg-white/20"
                    onClick={() => void refreshRemoteStatus()}
                  >
                    Re-check status
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {showTenantSections && (
          <>
            <div className="border border-slate-200 rounded-xl lg:col-span-2">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500"
                onClick={() => setViewTenantsOpen((prev) => !prev)}
              >
                <span>Home setup – view tenants</span>
                <span className="text-[11px] font-normal text-slate-400">
                  {viewTenantsOpen ? 'Hide' : 'Show'}
                </span>
              </button>
              {tenantLocked && (
                <p className="mx-4 mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  {TENANT_LOCKED_MESSAGE}
                </p>
              )}
              {viewTenantsOpen && (
                <div
                  className={`px-4 pb-4 pt-1 border-t border-slate-100 ${
                    tenantLocked ? 'pointer-events-none opacity-60' : ''
                  }`}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-slate-600">
                      View tenants in this home and manage their areas or delete accounts.
                    </p>
                    <button
                      type="button"
                      onClick={() => void fetchTenants()}
                      disabled={tenantsLoading || tenantLocked}
                      className="inline-flex items-center justify-center rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {tenantsLoading ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                  {tenantsError && (
                    <p className="mt-2 text-xs text-red-600">{tenantsError}</p>
                  )}
                  {tenantsLoading ? (
                    <p className="mt-3 text-xs text-slate-600">Loading tenants…</p>
                  ) : tenants.length === 0 ? (
                    <p className="mt-3 text-xs text-slate-600">No tenants yet.</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {tenants.map((tenant) => {
                        const tenantState = tenantActions[tenant.id] ?? {
                          saving: false,
                          error: null,
                        };
                        const selectedArea = tenantAreaInputs[tenant.id] ?? '';
                        const selectedAreaKeysForTenant = selectedTenantAreaKeys(tenant);
                        return (
                          <div
                            key={tenant.id}
                            className="rounded-lg border border-slate-200 p-3"
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">
                                  {tenant.username}
                                </p>
                                {tenant.email ? (
                                  <p className="mt-0.5 text-xs text-slate-600">{tenant.email}</p>
                                ) : null}
                                <div className="mt-1 flex flex-wrap gap-2">
                                  {selectedAreaKeysForTenant.length > 0 ? (
                                    selectedAreaKeysForTenant.map((areaKey) => (
                                      <span
                                        key={areaKey}
                                        className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[11px] text-slate-700"
                                      >
                                        <span>{areaLabelForValue(areaKey)}</span>
                                        <button
                                          type="button"
                                          className="text-slate-500 hover:text-slate-700"
                                          onClick={() => handleRemoveTenantArea(tenant.id, areaKey)}
                                          aria-label={`Remove ${areaLabelForValue(areaKey)}`}
                                          disabled={tenantLocked || tenantState.saving}
                                        >
                                          ×
                                        </button>
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-[11px] text-slate-500">
                                      No areas assigned.
                                    </span>
                                  )}
                                  {(tenant.partialAreaBuckets ?? []).map((partial) => {
                                    const partialKey = partial.displayKey?.trim() || partial.displayName.trim();
                                    const upgradeKey = partial.upgradeDisplayKey?.trim() || partialKey;
                                    return (
                                      <span
                                        key={`partial-${tenant.id}-${partialKey}`}
                                        className="flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800"
                                      >
                                        <span>{partial.displayName} (partial)</span>
                                        <button
                                          type="button"
                                          className="rounded-full border border-amber-300 px-2 py-0.5 text-[10px] font-semibold text-amber-900 hover:bg-amber-100"
                                          onClick={() => handleUpgradePartialTenantArea(tenant.id, upgradeKey)}
                                          disabled={tenantLocked || tenantState.saving}
                                        >
                                          Upgrade to full access
                                        </button>
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  className="w-full min-w-[200px] border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                                  value={selectedArea}
                                  onChange={(e) =>
                                    setTenantAreaInputs((prev) => ({
                                      ...prev,
                                      [tenant.id]: e.target.value,
                                    }))
                                  }
                                  disabled={
                                    tenantLocked ||
                                    tenantState.saving ||
                                    areaBuckets.length === 0
                                  }
                                >
                                  <option value="">
                                    {areaBuckets.length > 0
                                      ? 'Select an area'
                                      : 'No areas available'}
                                  </option>
                                  {areaBuckets.map((bucket) => {
                                    const key = areaBucketKey(bucket);
                                    return (
                                      <option key={key} value={key}>
                                        {bucket.displayName}
                                      </option>
                                    );
                                  })}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => handleAddTenantArea(tenant.id)}
                                  className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50"
                                  aria-label="Add area"
                                  disabled={
                                    tenantLocked ||
                                    tenantState.saving ||
                                    !selectedArea.trim()
                                  }
                                >
                                  <span className="text-lg leading-none">+</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openTenantDelete(tenant)}
                                  className="inline-flex items-center justify-center rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                  disabled={tenantLocked || tenantState.saving}
                                >
                                  Remove access
                                </button>
                              </div>
                            </div>
                            {tenantState.error && (
                              <p className="mt-2 text-xs text-red-600">{tenantState.error}</p>
                            )}
                            {tenantState.saving && !tenantLocked && (
                              <p className="mt-2 text-[11px] text-slate-500">
                                Saving changes…
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="border border-slate-200 rounded-xl lg:col-span-2">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500"
                onClick={() => setAddTenantOpen((prev) => !prev)}
              >
                <span>Home setup – property manager & tenants</span>
                <span className="text-[11px] font-normal text-slate-400">
                  {addTenantOpen ? 'Hide' : 'Show'}
                </span>
              </button>
              <div className="px-4 pb-3 text-[11px] text-slate-500">
                Property manager:{' '}
                <span className="font-medium text-slate-700">
                  {propertyManagerEmail?.trim() ? propertyManagerEmail.trim() : 'Not set'}
                </span>
              </div>
              {tenantLocked && (
                <p className="mx-4 mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  {TENANT_LOCKED_MESSAGE}
                </p>
              )}
              {addTenantOpen && (
                <div
                  className={`px-4 pb-4 pt-1 border-t border-slate-100 ${
                    tenantLocked ? 'pointer-events-none opacity-60' : ''
                  }`}
                >
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-xs font-semibold text-slate-900">Property manager email</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Optional. Property managers can approve tenant room access requests by email link.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={propertyManagerEmail}
                        onChange={(e) => setPropertyManagerEmail(e.target.value)}
                        placeholder="manager@example.com"
                        type="email"
                        disabled={propertyManagerLoading || tenantLocked}
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          setPropertyManagerMsg(null);
                          setPropertyManagerLoading(true);
                          try {
                            const res = await platformFetch('/api/admin/home/contacts', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ propertyManagerEmail }),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok) {
                              setPropertyManagerMsg({
                                type: 'error',
                                message: (data && typeof data.error === 'string' ? data.error : null) || 'Unable to save email.',
                              });
                              return;
                            }
                            setPropertyManagerEmail(data.propertyManagerEmail || '');
                            setPropertyManagerMsg({ type: 'success', message: 'Saved.' });
                          } catch (err) {
                            setPropertyManagerMsg({ type: 'error', message: friendlyUnknownError(err, 'Unable to save email.') });
                          } finally {
                            setPropertyManagerLoading(false);
                          }
                        }}
                        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        disabled={propertyManagerLoading || tenantLocked}
                      >
                        {propertyManagerLoading ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                    {propertyManagerMsg ? (
                      <p className={`mt-2 text-xs ${propertyManagerMsg.type === 'success' ? 'text-emerald-700' : 'text-rose-600'}`}>
                        {propertyManagerMsg.message}
                      </p>
                    ) : null}
                  </div>

                  <form onSubmit={handleTenantSubmit} className="mt-3 space-y-3">
                    <div>
                      <label className="block mb-1 text-xs">Tenant username</label>
                      <input
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={tenantForm.username}
                        onChange={(e) => updateTenantField('username', e.target.value)}
                        required
                        disabled={tenantLocked}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-xs">Tenant email</label>
                      <input
                        type="email"
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={tenantForm.email}
                        onChange={(e) => updateTenantField('email', e.target.value)}
                        required
                        disabled={tenantLocked}
                      />
                      <p className="mt-1 text-[11px] text-slate-500">
                        Tenants can sign in with email or username.
                      </p>
                    </div>
                    <div>
                      <label className="block mb-1 text-xs">Tenant password</label>
                      <input
                        type="password"
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={tenantForm.password}
                        onChange={(e) => updateTenantField('password', e.target.value)}
                        required
                        minLength={8}
                        disabled={tenantLocked}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-xs">Associated areas</label>
                      <div className="flex items-center gap-2">
                        <select
                          className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                          value={newAreaInput}
                          onChange={(e) => setNewAreaInput(e.target.value)}
                          disabled={tenantLocked || areaBuckets.length === 0}
                        >
                          <option value="">
                            {areaBuckets.length > 0
                              ? 'Select an area'
                              : 'No areas available'}
                          </option>
                          {areaBuckets.map((bucket) => {
                            const key = areaBucketKey(bucket);
                            return (
                              <option key={key} value={key}>
                                {bucket.displayName}
                              </option>
                            );
                          })}
                        </select>
                        <button
                          type="button"
                          onClick={() => addArea()}
                          className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50"
                          aria-label="Add area"
                          disabled={tenantLocked || !newAreaInput}
                        >
                          <span className="text-lg leading-none">+</span>
                        </button>
                      </div>
                      {tenantForm.areas.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {tenantForm.areas.map((area) => (
                            <span
                              key={area}
                              className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[11px] text-slate-700"
                            >
                              <span>{areaLabelForValue(area)}</span>
                              <button
                                type="button"
                                className="text-slate-500 hover:text-slate-700"
                                onClick={() => removeArea(area)}
                                aria-label={`Remove ${areaLabelForValue(area)}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="mt-1 text-[11px] text-slate-500">
                        Choose one or more rooms to give access to.
                      </p>
                    </div>
                    <button
                      type="submit"
                      disabled={tenantLoading || tenantLocked}
                      className="mt-1 bg-indigo-600 text-white rounded-lg py-2 px-4 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {tenantLoading ? 'Adding…' : 'Add tenant'}
                    </button>
                  </form>
                  {tenantMsg && (
                    <p className="mt-2 text-xs text-slate-600">{tenantMsg}</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {showOverrideSection && (
          <div className="border border-slate-200 rounded-xl p-4 lg:col-span-2">
            <div className="flex flex-col items-center justify-center gap-3 pb-2 text-sm">
              <h2 className="text-base font-semibold text-slate-900">Configuration</h2>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <div className="relative" ref={areaMenuRef}>
                  <button
                    type="button"
                    onClick={() => setAreaMenuOpen((v) => !v)}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-300"
                  >
                    <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Area</span>
                    <span className="text-slate-800">
                      {filterAreas.length === 0 ? 'All' : `${filterAreas.length} selected`}
                    </span>
                    <span className="text-slate-400">▾</span>
                  </button>
                  {areaMenuOpen && (
                    <div className="absolute left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs text-slate-700 shadow-lg backdrop-blur">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Areas</span>
                        <button
                          type="button"
                          className="text-[11px] text-indigo-600 hover:text-indigo-800"
                          onClick={() => setFilterAreas([])}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                        {areaBuckets.map((bucket) => (
                          <label key={bucket.displayKey} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              checked={filterAreas.includes(bucket.displayName)}
                              onChange={(e) => {
                                setFilterAreas((prev) =>
                                  e.target.checked ? [...prev, bucket.displayName] : prev.filter((a) => a !== bucket.displayName)
                                );
                              }}
                            />
                            <span className="truncate">{bucket.displayName}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="relative" ref={labelMenuRef}>
                  <button
                    type="button"
                    onClick={() => setLabelMenuOpen((v) => !v)}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-300"
                  >
                    <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Label</span>
                    <span className="text-slate-800">
                      {filterLabels.length === 0 ? 'All' : `${filterLabels.length} selected`}
                    </span>
                    <span className="text-slate-400">▾</span>
                  </button>
                  {labelMenuOpen && (
                    <div className="absolute left-1/2 z-20 mt-2 w-56 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white/95 p-3 text-xs text-slate-700 shadow-lg backdrop-blur">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Labels</span>
                        <button
                          type="button"
                          className="text-[11px] text-indigo-600 hover:text-indigo-800"
                          onClick={() => setFilterLabels([])}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                        {labelBuckets.map((bucket) => (
                          <label key={bucket.displayKey} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              checked={filterLabels.includes(bucket.displayName)}
                              onChange={(e) => {
                                setFilterLabels((prev) =>
                                  e.target.checked ? [...prev, bucket.displayName] : prev.filter((l) => l !== bucket.displayName)
                                );
                              }}
                            />
                            <span className="truncate">{bucket.displayName}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          {overrideAlert && (
            <p
              className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                overrideAlert.type === 'success'
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border border-red-200 bg-red-50 text-red-700'
              }`}
            >
              {overrideAlert.message}
            </p>
          )}
          <div className="mt-4 grid gap-4">
          <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Areas</h3>
                <p className="text-[11px] text-slate-500">Set the area names everyone sees.</p>
              </div>
              <button
                type="button"
                onClick={() => void resetAreasToOriginal()}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
              >
                Reset areas to original
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {areaOptions.map((area) => (
                <button
                  key={area.haAreaName}
                  type="button"
                  onClick={() => {
                    setEditingArea(area);
                    setDisplayNameDraft(area.displayName);
                  }}
                  className="rounded-xl border border-slate-200 bg-white p-3 text-left text-xs shadow-sm hover:border-indigo-200"
                >
                  <div className="font-semibold text-slate-900">{area.displayName}</div>
                  <div className="mt-1 text-[11px] text-slate-500">Original: {area.haAreaName}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Labels</h3>
                <p className="text-[11px] text-slate-500">Set friendly label names. Tenant-created devices are hidden here.</p>
              </div>
              <button
                type="button"
                onClick={() => void resetLabelsToOriginal()}
                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
              >
                Reset labels to original
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {visibleLabelOptions.map((label) => (
                <button
                  key={label.sourceTechnicalLabel}
                  type="button"
                  onClick={() => {
                    setEditingLabel(label);
                    setDisplayNameDraft(label.displayName);
                  }}
                  className="rounded-xl border border-slate-200 bg-white p-3 text-left text-xs shadow-sm hover:border-indigo-200"
                >
                  <div className="font-semibold text-slate-900">{label.displayName}</div>
                  <div className="mt-1 text-[11px] text-slate-500">Original: {label.sourceTechnicalLabel}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Devices</h3>
                <p className="text-[11px] text-slate-500">Edit device names, or choose an area and label from the lists above.</p>
              </div>
              <div className="flex flex-col items-end gap-2 text-right text-[11px] text-slate-500">
                <div>{visibleOverrides.length} items</div>
                <button
                  type="button"
                  onClick={() => void resetDevicesToOriginal()}
                  className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  Reset devices to original
                </button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleOverrides.map((ov) => {
                  const areaName = ov.displayAreaName || ov.area || 'Unassigned';
                  const labelName = ov.displayLabel || ov.label || '';
                  const areaColor = stringToColor(areaName);
                  return (
                    <div
                      key={ov.entityId}
                      className="flex h-full flex-col rounded-2xl border border-slate-200/70 bg-white/90 p-3 shadow-sm hover:border-slate-300 hover:shadow-md transition"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{cleanDisplay(ov.name || ov.entityId)}</p>
                          <p className="font-mono text-[11px] text-slate-500 truncate">{ov.entityId}</p>
                        </div>
                        <button
                          type="button"
                          className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-medium text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50"
                          onClick={() => startEditOverride(ov)}
                        >
                          Edit
                        </button>
                      </div>

                      {Array.isArray(ov.linkedSensors) && ov.linkedSensors.length > 0 && (
                        <div className="mt-2 rounded-xl border border-slate-100 bg-slate-50/70 p-2">
                          <p className="text-[11px] uppercase tracking-[0.15em] text-slate-400">Linked sensors</p>
                          <div className="mt-1 max-h-24 overflow-y-auto space-y-1 pr-1">
                            {ov.linkedSensors.map((ls) => (
                              <div key={ls.entityId} className="flex items-center justify-between gap-2 text-[12px] text-slate-700">
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-slate-900">{cleanDisplay(ls.name || ls.entityId)}</div>
                                  <div className="truncate font-mono text-[10px] text-slate-500">{ls.entityId}</div>
                                </div>
                                <span className="text-[11px] text-slate-500">{ls.unit || ''}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-auto flex items-center justify-between pt-3">
                        <span
                          className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium text-slate-900"
                          style={{ backgroundColor: areaColor.bg, color: areaColor.fg }}
                        >
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: areaColor.fg }} />
                          {areaName}
                        </span>
                        <span className="text-xs font-semibold text-slate-700">{labelName}</span>
                      </div>
                    </div>
                  );
                })}
              {overrides.length === 0 && (
                <div className="text-sm text-slate-500">No overrides yet.</div>
              )}
              {overrides.length > 0 && visibleOverrides.length === 0 && (
                <div className="col-span-full flex flex-col items-center gap-2 rounded-xl border border-slate-200/70 bg-slate-50 p-4 text-sm text-slate-600">
                  <span>No devices match your filters.</span>
                  <button
                    type="button"
                    className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700"
                    onClick={() => {
                      setFilterAreas([]);
                      setFilterLabels([]);
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          </div>

          </div>

          {editingOverrideId && (
            <div className="mt-4 rounded-lg border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Edit Device Settings</h3>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-slate-500">Entity ID</label>
                  <input
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={overrideForm.entityId}
                    onChange={(e) =>
                      setOverrideForm((prev) => ({ ...prev, entityId: e.target.value }))
                    }
                    disabled
                    placeholder="sensor.power_xxx"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-500">Name</label>
                  <input
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={overrideForm.name}
                    onChange={(e) =>
                      setOverrideForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="Friendly name"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-500">Area</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={overrideForm.area}
                    onChange={(e) => setOverrideForm((prev) => ({ ...prev, area: e.target.value }))}
                  >
                    <option value="">Select area</option>
                    {areaOptions.map((area) => (
                      <option key={area.haAreaName} value={area.haAreaName}>
                        {getAreaOptionLabel(area)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-500">Label</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={overrideForm.label}
                    onChange={(e) => setOverrideForm((prev) => ({ ...prev, label: e.target.value }))}
                  >
                    <option value="">Select label</option>
                    {visibleLabelOptions.map((label) => (
                      <option key={label.sourceTechnicalLabel} value={label.sourceTechnicalLabel}>
                        {getLabelOptionLabel(label)}
                      </option>
                    ))}
                  </select>
                </div>
                {overrideForm.label === 'Blind' && (
                  <div>
                    <label className="mb-1 block text-[11px] text-slate-500">Blind travel (seconds)</label>
                    <input
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                      value={overrideForm.blindTravelSeconds}
                      onChange={(e) =>
                        setOverrideForm((prev) => ({ ...prev, blindTravelSeconds: e.target.value }))
                      }
                      placeholder="Leave blank unless calibrating blinds"
                    />
                  </div>
                )}
                {overrideForm.label === 'Boiler' && (
                  <>
                    <div>
                      <label className="mb-1 block text-[11px] text-slate-500">Boiler power (kW) — used to estimate kWh</label>
                      <input
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={overrideForm.boilerPowerKw}
                        onChange={(e) => setOverrideForm((prev) => ({ ...prev, boilerPowerKw: e.target.value }))}
                        placeholder="Leave blank to use default"
                      />
                      <p className="mt-1 text-[11px] text-slate-500">
                        We do <span className="font-semibold">not</span> read “boiler kWh” from your boiler. We estimate it from runtime:
                        <span className="font-mono"> kWh = (minutes ON ÷ 60) × kW</span>.
                        <span> You can usually find kW on the boiler spec plate/manual (max output).</span>
                      </p>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] text-slate-500">Boiler efficiency band (A–G) — used to estimate kWh</label>
                      <select
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={overrideForm.boilerEfficiencyBand}
                        onChange={(e) =>
                          setOverrideForm((prev) => ({ ...prev, boilerEfficiencyBand: e.target.value }))
                        }
                      >
                        <option value="">Default (Band B)</option>
                        {['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((b) => (
                          <option key={b} value={b}>
                            Band {b}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-[11px] text-slate-500">
                        This affects the estimated average boiler output while heating (thermal-state modulation). Leave blank to use the default.
                      </p>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] text-slate-500">Heating price (£/kWh) — used to estimate cost</label>
                      <input
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={overrideForm.heatingPricePerKwh}
                        onChange={(e) =>
                          setOverrideForm((prev) => ({ ...prev, heatingPricePerKwh: e.target.value }))
                        }
                        placeholder="Leave blank to use default"
                      />
                      <p className="mt-1 text-[11px] text-slate-500">
                        Estimated cost:
                        <span className="font-mono"> cost = kWh × £/kWh</span>. Defaults come from server config if blank.
                        <span> Use your gas/electric tariff unit rate.</span>
                      </p>
                    </div>
                  </>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void saveOverride()}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-700"
                >
                  Save device settings
                </button>
                <button
                  type="button"
                  onClick={() => setEditingOverrideId(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!editingOverrideId && (
            <div className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50/80 p-4 text-xs text-slate-600">
              Select a device to edit settings for.
            </div>
          )}
          {(editingArea || editingLabel) && (
            <Modal
              open={Boolean(editingArea || editingLabel)}
              title={editingArea ? 'Edit area name' : 'Edit label name'}
              onClose={() => {
                setEditingArea(null);
                setEditingLabel(null);
                setDisplayNameDraft('');
              }}
            >
              <div className="space-y-3 text-sm">
                <p className="text-xs text-slate-500">
                  Original: {editingArea?.haAreaName ?? editingLabel?.sourceTechnicalLabel}
                </p>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                  value={displayNameDraft}
                  onChange={(e) => setDisplayNameDraft(e.target.value)}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      setEditingArea(null);
                      setEditingLabel(null);
                      setDisplayNameDraft('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
                    onClick={() => (editingArea ? void saveAreaDisplayName() : void saveLabelDisplayName())}
                  >
                    Save
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>
        )}

        {showDeregister && (
          <div
            className={`border border-slate-200 rounded-xl p-4 lg:col-span-2 ${
              deregisterLocked ? 'bg-slate-50 opacity-70 pointer-events-none' : ''
            }`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold">Deregister Property</h2>
                <p className="text-[11px] text-slate-500 mt-1">
                  Issue a one-time claim code for the next homeowner.
                </p>
              </div>
              <button
                type="button"
                onClick={openSellingModal}
                disabled={sellingLoading || deregisterLocked}
                className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {sellingClaimCode ? 'View claim code' : 'Deregister Property'}
              </button>
            </div>
            {deregisterLocked && (
              <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Remote access must be enabled for you to deregister your smart home from this
                website. To deregister your smart home without paying for remote access you
                will have to use your iOS/Android phone or the Dinodia Kiosk.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-600">
              Choose if everyone is leaving or if tenants stay. FULL_RESET removes all users, tenant-owned
              devices/entities and tenant-created automations, telemetry, onboarding/support artifacts, and
              scrubs the property address to UNCLAIMED. OWNER_TRANSFER removes only you, keeps occupiers active, and scrubs monitoring + heating telemetry so the incoming homeowner starts fresh.
            </p>
            {sellingPreviewLoading && (
              <p className="mt-2 text-xs text-slate-500">Loading deregister impact preview…</p>
            )}
            {sellingPreview?.fullReset && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
                <p className="font-semibold text-slate-800">FULL_RESET impact preview</p>
                <p>
                  Tenant devices: {sellingPreview.fullReset.haTargets?.tenantOwnedDeviceIds?.length ?? 0} ·
                  Tenant entities: {sellingPreview.fullReset.haTargets?.tenantOwnedEntityIds?.length ?? 0} ·
                  Tenant automations: {sellingPreview.fullReset.haTargets?.tenantAutomationIds?.length ?? 0}
                </p>
                <p>
                  Users: {sellingPreview.fullReset.dbCounts?.users ?? 0} ·
                  Monitoring readings: {sellingPreview.fullReset.dbCounts?.monitoringReadings ?? 0} ·
                  Boiler readings: {sellingPreview.fullReset.dbCounts?.boilerTemperatureReadings ?? 0} ·
                  Boiler usage rows: {sellingPreview.fullReset.dbCounts?.boilerUsageAccumulators ?? 0} ·
                  Radiator usage rows: {sellingPreview.fullReset.dbCounts?.radiatorUsageAccumulators ?? 0} ·
                  Pending onboarding: {sellingPreview.fullReset.dbCounts?.pendingHomeownerOnboardings ?? 0}
                </p>
              </div>
            )}
            {sellingPreview?.ownerTransfer && (
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
                <p className="font-semibold text-slate-800">OWNER_TRANSFER impact preview</p>
                <p>
                  Users removed: {sellingPreview.ownerTransfer.dbCounts?.users ?? 0} ·
                  Trusted devices: {sellingPreview.ownerTransfer.dbCounts?.trustedDevices ?? 0} ·
                  Auth challenges: {sellingPreview.ownerTransfer.dbCounts?.authChallenges ?? 0}
                </p>
                <p>
                  Monitoring readings scrubbed: {sellingPreview.ownerTransfer.dbCounts?.monitoringReadings ?? 0} ·
                  Boiler readings scrubbed: {sellingPreview.ownerTransfer.dbCounts?.boilerTemperatureReadings ?? 0} ·
                  Boiler usage rows reset: {sellingPreview.ownerTransfer.dbCounts?.boilerUsageAccumulators ?? 0} ·
                  Radiator usage rows reset: {sellingPreview.ownerTransfer.dbCounts?.radiatorUsageAccumulators ?? 0}
                </p>
              </div>
            )}
            {sellingClaimCode && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                A claim code has already been generated for this home. Share it with the incoming
                homeowner before you finish.
              </p>
            )}
          </div>
        )}

          </div>
        </section>

      <Modal
        open={Boolean(tenantToDelete)}
        onClose={() => setTenantToDelete(null)}
        title="Remove tenant access?"
        description="This will remove this tenant's access and Dinodia-managed automation ownership for this home."
        width="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Tenant: <span className="font-semibold text-foreground">{tenantToDelete?.username}</span>
          </p>
          {tenantDeleteError && (
            <p className="rounded-lg border border-[color:var(--danger)] bg-[color:var(--danger)]/12 px-3 py-2 text-xs text-foreground">
              {tenantDeleteError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={tenantDeleteLoading}
              onClick={() => void confirmDeleteTenant()}
            >
              Remove access
            </Button>
            <Button
              variant="secondary"
              onClick={() => setTenantToDelete(null)}
              disabled={tenantDeleteLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {sellingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Deregister Property</h3>
                <p className="text-xs text-slate-500">
                  Review impact and confirm how you want to deregister this property.
                </p>
              </div>
              <button
                type="button"
                onClick={closeSellingModal}
                disabled={sellingLoading}
                className="text-slate-500 hover:text-slate-700"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {sellingClaimCode ? (
              <div className="mt-5 space-y-4">
                <p className="text-sm text-slate-700">
                  Share this code with the new homeowner. It only shows once and you&apos;ll be
                  signed out after you confirm.
                </p>
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                  <span className="font-mono text-lg font-semibold tracking-widest text-indigo-900">
                    {sellingClaimCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyClaimCode()}
                    className="rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-medium text-indigo-700 shadow-sm hover:bg-indigo-50"
                  >
                    Copy
                  </button>
                </div>
                {claimCopyStatus && (
                  <p className="text-xs text-indigo-700">{claimCopyStatus}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                    onClick={() => void handleLogout()}
                  >
                    I saved the code
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={closeSellingModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div className="grid gap-3">
                  <button
                    type="button"
                    onClick={() => selectSellingMode('FULL_RESET')}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                      sellingMode === 'FULL_RESET'
                        ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                    disabled={sellingLoading}
                  >
                    <p className="text-sm font-semibold">
                      Deregister your whole household (Homeowner + Occupiers)
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      Fully reset this home so the next owner starts fresh.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectSellingMode('OWNER_TRANSFER')}
                    className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                      sellingMode === 'OWNER_TRANSFER'
                        ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                    disabled={sellingLoading}
                  >
                    <p className="text-sm font-semibold">
                      Deregister yourself but keep all occupiers control active (Only a household
                      owner change)
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      Remove your ownership while keeping tenant devices and automations.
                    </p>
                  </button>
                </div>

                {sellingMode && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                    <p className="text-sm font-semibold">Please confirm</p>
                    <p className="mt-2 text-sm">
                      {sellingMode === 'FULL_RESET'
                        ? 'This will remove all users, tenant-created devices/entities and automations, tenant Alexa links, monitoring + boiler telemetry, support/onboarding records, and scrub home address fields to UNCLAIMED.'
                        : 'This will remove only your homeowner account, keep tenants and the home active, and generate a claim code for the incoming homeowner.'}
                    </p>
                    <p className="mt-3 text-xs font-semibold uppercase tracking-wide">Is this ok?</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                        disabled={sellingLoading}
                        onClick={() => void confirmSellingSelection(sellingMode)}
                      >
                        {sellingLoading ? 'Working…' : 'Yes'}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={sellingLoading}
                        onClick={() => setSellingMode(null)}
                      >
                        Cancel
                      </button>
                    </div>
                    {sellingError && (
                      <p className="mt-2 text-xs text-red-700">{sellingError}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
