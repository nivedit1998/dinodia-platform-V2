// Architecture: App Router surface src/app/tenant/ui/AddMatterDeviceWizard.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import jsQR from 'jsqr';
import type { HaConfigFlowStep } from '@/lib/matterConfigFlow';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';

type Props = {
  areas: string[];
  areaOptions?: AreaOption[];
  capabilityOptions: string[];
};

const OTHER_LABEL_ERROR = 'Label cannot be Other, please be more specific';
const isReservedOtherLabel = (value: string) => value.trim().toLowerCase() === 'other';

type AreaOption = { haAreaName: string; displayName: string };
type TenantVirtualArea = {
  id: string;
  parentHaAreaName: string;
  parentDisplayAreaName?: string | null;
  displayName: string;
};

type SessionPayload = {
  id: string;
  status: string;
  requestedArea: string;
  requestedName: string | null;
  requestedDisplayLabel: string | null;
  requestedVirtualAreaId: string | null;
  requestedNewVirtualAreaName: string | null;
  haFlowId: string | null;
  error: string | null;
  lastHaStep?: HaConfigFlowStep | null;
  newDeviceIds: string[];
  newEntityIds: string[];
  isFinal?: boolean;
};

const steps = ['Area', 'Pairing code', 'Metadata', 'Wi-Fi', 'Progress'];

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function buildStatusMessage(session: SessionPayload | null) {
  if (!session) return 'Waiting to start commissioning...';
  if (session.status === 'SUCCEEDED') return 'Commissioning completed';
  if (session.status === 'FAILED') return session.error || 'Commissioning was unsuccessful';
  if (session.status === 'CANCELED') return 'Commissioning was canceled';
  const lastStep = session.lastHaStep;
  if (lastStep?.progress_action === 'wait') return 'Home Assistant is configuring the device...';
  if (lastStep?.type === 'progress') return 'Commissioning in progress...';
  if (lastStep?.type === 'form') return 'Waiting for pairing details...';
  return 'Contacting Home Assistant...';
}

export default function AddMatterDeviceWizard(props: Props) {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedArea, setSelectedArea] = useState<string>(props.areas[0] ?? '');
  const [pairingCode, setPairingCode] = useState('');
  const [requestedName, setRequestedName] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [selectedVirtualAreaId, setSelectedVirtualAreaId] = useState('');
  const [newVirtualSubAreaName, setNewVirtualSubAreaName] = useState('');
  const [virtualAreas, setVirtualAreas] = useState<TenantVirtualArea[]>([]);
  const [virtualAreasError, setVirtualAreasError] = useState<string | null>(null);
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const hasAllInputs =
    Boolean(selectedArea) &&
    Boolean(requestedName.trim()) &&
    Boolean(displayLabel.trim()) &&
    Boolean(pairingCode.trim()) &&
    Boolean(wifiSsid.trim()) &&
    Boolean(wifiPassword.trim());

  const sortedCapabilityOptions = useMemo(
    () => [...props.capabilityOptions].sort((a, b) => a.localeCompare(b)),
    [props.capabilityOptions]
  );
  const areaOptions = useMemo<AreaOption[]>(
    () =>
      props.areaOptions?.length
        ? props.areaOptions
        : props.areas.map((area) => ({ haAreaName: area, displayName: area })),
    [props.areaOptions, props.areas]
  );
  const selectedAreaDisplayName =
    areaOptions.find((area) => area.haAreaName === selectedArea)?.displayName || selectedArea;
  const virtualAreasForSelectedArea = virtualAreas.filter(
    (area) =>
      area.parentHaAreaName === selectedArea ||
      area.parentDisplayAreaName === selectedArea
  );
  const displayAreaName = useMemo(
    () => (areaName: string | null | undefined) => {
      const cleaned = (areaName ?? '').trim();
      if (!cleaned) return '';
      return areaOptions.find((area) => area.haAreaName === cleaned)?.displayName ?? cleaned;
    },
    [areaOptions]
  );

  useEffect(() => {
    const areaNames = areaOptions.map((area) => area.haAreaName);
    if (areaNames.length > 0 && !areaNames.includes(selectedArea)) {
      setSelectedArea(areaNames[0]);
    }
  }, [areaOptions, selectedArea]);

  useEffect(() => {
    let active = true;
    async function loadVirtualAreas() {
      setVirtualAreasError(null);
      try {
        const data = await platformFetchJson<{ virtualAreas?: TenantVirtualArea[] }>(
          '/api/tenant/virtual-areas',
          { cache: 'no-store' },
          'Unable to load your sub-areas.'
        );
        if (active) setVirtualAreas(Array.isArray(data.virtualAreas) ? data.virtualAreas : []);
      } catch (err) {
        if (active) setVirtualAreasError(friendlyUnknownError(err, 'Unable to load your sub-areas.'));
      }
    }
    void loadVirtualAreas();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (currentStep !== 1) {
      setScanning(false);
    }
  }, [currentStep]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (!scanning) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      return;
    }

    let canceled = false;

    async function startScan() {
      setScanError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (canceled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const tick = () => {
          if (!videoRef.current || !canvasRef.current) {
            animationRef.current = requestAnimationFrame(tick);
            return;
          }
          const width = videoRef.current.videoWidth;
          const height = videoRef.current.videoHeight;
          if (!width || !height) {
            animationRef.current = requestAnimationFrame(tick);
            return;
          }
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            animationRef.current = requestAnimationFrame(tick);
            return;
          }
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(videoRef.current, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);
          const code = jsQR(imageData.data, width, height);
          if (code?.data) {
            setPairingCode(code.data.trim());
            setScanning(false);
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          animationRef.current = requestAnimationFrame(tick);
        };

        animationRef.current = requestAnimationFrame(tick);
      } catch {
        if (!canceled) {
          setScanError('Camera is unavailable or permission was denied.');
          setScanning(false);
        }
      }
    }

    void startScan();

    return () => {
      canceled = true;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning]);

  const statusMessage = useMemo(() => buildStatusMessage(session), [session]);

  const handleUpload = async (file: File) => {
    setScanError(null);
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      img.src = reader.result;
    };
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0, img.width, img.height);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const code = jsQR(imageData.data, img.width, img.height);
      if (code?.data) {
        setPairingCode(code.data.trim());
        setScanError(null);
      } else {
        setScanError('No QR code detected in the image.');
      }
    };
    reader.readAsDataURL(file);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollSession = (id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const data = await platformFetchJson<{ session: SessionPayload }>(
          `/api/tenant/matter/sessions/${id}`,
          { cache: 'no-store' },
          'Unsuccessful - unable to check commissioning progress right now.'
        );
        const nextSession: SessionPayload = data.session;
        setSession(nextSession);
        if (
          nextSession.status === 'SUCCEEDED' ||
          nextSession.status === 'FAILED' ||
          nextSession.status === 'CANCELED'
        ) {
          stopPolling();
          if (nextSession.status === 'SUCCEEDED') {
            setCurrentStep(4);
          }
        }
      } catch (err) {
        console.error('Polling session failed', err);
        setError(
          friendlyUnknownError(err, 'Unsuccessful - unable to check commissioning progress right now.')
        );
        stopPolling();
      }
    }, 3000);
  };

  const startCommissioning = async () => {
    setError(null);
    setWarnings([]);
    if (!selectedArea) {
      setError('Please choose an area.');
      return;
    }
    if (!requestedName.trim()) {
      setError('Please enter a device name.');
      return;
    }
    if (!displayLabel.trim()) {
      setError('Please enter a label for this device.');
      return;
    }
    if (isReservedOtherLabel(displayLabel)) {
      setError(OTHER_LABEL_ERROR);
      return;
    }
    if (!pairingCode.trim()) {
      setError('Pairing code is required.');
      return;
    }
    if (!wifiSsid.trim() || !wifiPassword.trim()) {
      setError('Wi-Fi credentials are required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const createData = await platformFetchJson<{ session: SessionPayload; warnings?: string[] }>(
        '/api/tenant/matter/sessions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parentAreaName: selectedArea,
            displayName: requestedName.trim(),
            displayLabel: displayLabel.trim(),
            selectedVirtualAreaId: selectedVirtualAreaId || null,
            newVirtualSubAreaName: newVirtualSubAreaName.trim() || null,
            setupPayload: pairingCode.trim(),
            manualPairingCode: pairingCode.trim(),
          }),
        },
        'Unable to start commissioning.'
      );
      const createdSession: SessionPayload = createData.session;
      const accumulatedWarnings: string[] = [...(createData?.warnings ?? [])];
      setSession(createdSession);
      setCurrentStep(4);

      const stepData = await platformFetchJson<{ session?: SessionPayload; warnings?: string[] }>(
        `/api/tenant/matter/sessions/${createdSession.id}/step`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setupPayload: pairingCode.trim(),
            manualPairingCode: pairingCode.trim(),
            wifiSsid: wifiSsid.trim(),
            wifiPassword: wifiPassword,
          }),
        },
        'Home Assistant rejected the pairing details.'
      );
      setWifiPassword('');
      if (!stepData?.session) {
        throw new Error('Home Assistant rejected the pairing details.');
      }
      const nextSession: SessionPayload = stepData.session;
      setSession(nextSession);
      setWarnings([...accumulatedWarnings, ...(stepData?.warnings ?? [])]);

      if (nextSession.status === 'SUCCEEDED') {
        stopPolling();
      } else {
        pollSession(nextSession.id);
      }
    } catch (err) {
      console.error(err);
      setError(friendlyUnknownError(err, 'Something went wrong while starting commissioning.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelSession = async () => {
    if (!session) return;
    try {
      const data = await platformFetchJson<{ session?: SessionPayload }>(
        `/api/tenant/matter/sessions/${session.id}/cancel`,
        {
          method: 'POST',
        },
        'Unable to cancel commissioning right now.'
      );
      stopPolling();
      if (data?.session) setSession(data.session);
    } catch (err) {
      console.error(err);
      setError(friendlyUnknownError(err, 'Unable to cancel commissioning right now.'));
    }
  };

  const resetWizard = () => {
    stopPolling();
    setSession(null);
    setWarnings([]);
    setError(null);
    setPairingCode('');
    setRequestedName('');
    setDisplayLabel('');
    setSelectedVirtualAreaId('');
    setNewVirtualSubAreaName('');
    setWifiSsid('');
    setWifiPassword('');
    setCurrentStep(0);
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Choose where this device should appear for you. You can only place devices in areas you
              have access to.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {areaOptions.map((area) => (
                <button
                  key={area.haAreaName}
                  type="button"
                  onClick={() => {
                    setSelectedArea(area.haAreaName);
                    setSelectedVirtualAreaId('');
                    setNewVirtualSubAreaName('');
                  }}
                  className={classNames(
                    'flex items-center justify-between rounded-xl border px-4 py-3 text-left transition',
                    selectedArea === area.haAreaName
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-900 shadow-sm'
                      : 'border-slate-200 bg-white text-slate-800 hover:border-indigo-200'
                  )}
                >
                  <span className="font-semibold">{area.displayName}</span>
                  {selectedArea === area.haAreaName ? (
                    <span className="text-xs text-indigo-700">Selected</span>
                  ) : (
                    <span className="text-xs text-slate-500">Tap to choose</span>
                  )}
                </button>
              ))}
              {areaOptions.length === 0 && (
                <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  No areas have been shared with you yet. Ask the homeowner to grant access.
                </p>
              )}
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Scan the Matter QR code with your camera, upload a photo, or type the code manually.
            </p>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">Camera scan</p>
                    <p className="text-xs text-slate-600">Best for mobile devices</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setScanning((prev) => !prev)}
                    className={classNames(
                      'rounded-full px-3 py-1 text-xs font-semibold shadow-sm',
                      scanning
                        ? 'bg-rose-50 text-rose-700 border border-rose-100'
                        : 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                    )}
                  >
                    {scanning ? 'Stop scan' : 'Start scan'}
                  </button>
                </div>
                <div className="aspect-video overflow-hidden rounded-xl bg-slate-50">
                  <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                </div>
                {scanError && <p className="text-sm text-rose-600">{scanError}</p>}
              </div>
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <p className="font-semibold text-slate-900">Upload or type</p>
                  <p className="text-xs text-slate-600">
                    We will decode the QR from the image or use your manual code.
                  </p>
                </div>
                <label className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 hover:border-indigo-200 hover:bg-indigo-50">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleUpload(file);
                    }}
                  />
                  Upload QR image
                </label>
                <div>
                  <label className="text-xs font-semibold text-slate-700">Pairing code</label>
                  <input
                    type="text"
                    value={pairingCode}
                    onChange={(e) => setPairingCode(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                    placeholder="MT:..."
                  />
                </div>
              </div>
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-700">Device name</label>
              <input
                type="text"
                value={requestedName}
                onChange={(e) => setRequestedName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                placeholder="Plug 1"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">Label shown on your dashboard</label>
                <input
                  value={displayLabel}
                  onChange={(e) => setDisplayLabel(e.target.value)}
                  list="matter-display-label-suggestions"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                  placeholder="Kettle, Desk lamp, Heater..."
                />
                <datalist id="matter-display-label-suggestions">
                  {sortedCapabilityOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
                <p className="text-xs text-slate-500">
                  This is only the section label you see. Device behavior is inferred automatically.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">Optional sub-area</label>
                <select
                  value={selectedVirtualAreaId}
                  onChange={(e) => {
                    setSelectedVirtualAreaId(e.target.value);
                    if (e.target.value) setNewVirtualSubAreaName('');
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">Use parent area</option>
                  {virtualAreasForSelectedArea.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.displayName}
                    </option>
                  ))}
                </select>
                <input
                  value={newVirtualSubAreaName}
                  onChange={(e) => {
                    setNewVirtualSubAreaName(e.target.value);
                    if (e.target.value.trim()) setSelectedVirtualAreaId('');
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                  placeholder="Counter, Desk, Bedside..."
                />
                <p className="text-xs text-slate-500">
                  Leave both blank to show this device directly under {selectedAreaDisplayName || 'the selected area'}.
                </p>
                {virtualAreasError ? <p className="text-xs text-amber-600">{virtualAreasError}</p> : null}
              </div>
            </div>
          </div>
        );
      case 3:
        return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Enter the Wi-Fi credentials for the network your Matter device should join. We only send
              these to Home Assistant for commissioning and do not store them.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs font-semibold text-slate-700">Wi-Fi name (SSID)</label>
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                  placeholder="Network name"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700">Wi-Fi password</label>
                <input
                  type="password"
                  value={wifiPassword}
                  onChange={(e) => setWifiPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-inner focus:border-indigo-400 focus:outline-none"
                  placeholder="Password"
                />
              </div>
            </div>
          </div>
        );
      case 4:
      default:
        return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              We are sending the pairing request to Home Assistant. Keep this page open until it finishes.
            </p>
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 shadow-inner">
              {statusMessage}
            </div>
            {warnings.length > 0 && (
              <div className="space-y-2 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-inner">
                <p className="font-semibold">Warnings</p>
                <ul className="list-disc space-y-1 pl-4">
                  {warnings.map((warning, idx) => (
                    <li key={idx}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {session?.newEntityIds?.length ? (
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
                <p className="font-semibold text-slate-900">New entities</p>
                <ul className="mt-2 space-y-1 text-slate-700">
                  {session.newEntityIds.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {session?.status === 'SUCCEEDED' && (
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 shadow-inner">
                <p className="font-semibold">Applied display details</p>
                <ul className="mt-2 space-y-1 text-emerald-900">
                  <li>
                    <span className="font-semibold">Area:</span> {displayAreaName(session.requestedArea)}
                  </li>
                  {session.requestedName && (
                    <li>
                      <span className="font-semibold">Name:</span> {session.requestedName}
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Add Matter device</p>
            <h1 className="text-2xl font-semibold text-slate-900">Commission a new device</h1>
            <p className="text-sm text-slate-600">
              Walk through the steps to bring a Matter-over-Wi-Fi device into your home.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/tenant/dashboard"
              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              Back to dashboard
            </Link>
            {session?.status === 'SUCCEEDED' && (
              <button
                type="button"
                onClick={() => router.refresh()}
                className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
              >
                Refresh devices
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            {steps.map((label, idx) => (
              <div
                key={label}
                className={classNames(
                  'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
                  idx === currentStep
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-800'
                    : idx < currentStep
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                )}
              >
                <span
                  className={classNames(
                    'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                    idx === currentStep
                      ? 'bg-indigo-600 text-white'
                      : idx < currentStep
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-200 text-slate-700'
                  )}
                >
                  {idx + 1}
                </span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm backdrop-blur">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              <span>{error}</span>
            </div>
          )}

          {renderStepContent()}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              Step {currentStep + 1} of {steps.length}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {currentStep > 0 && currentStep < 4 && (
                <button
                  type="button"
                  onClick={() => setCurrentStep((prev) => Math.max(0, prev - 1))}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Back
                </button>
              )}
              {currentStep < 3 && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setCurrentStep((prev) => Math.min(3, prev + 1));
                  }}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                >
                  Continue
                </button>
              )}
              {currentStep === 3 && (
                <button
                  type="button"
                  onClick={startCommissioning}
                  disabled={!hasAllInputs || isSubmitting}
                  className={classNames(
                    'rounded-full px-4 py-2 text-sm font-semibold shadow-sm',
                    hasAllInputs && !isSubmitting
                      ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                      : 'bg-slate-200 text-slate-500'
                  )}
                >
                  {isSubmitting ? 'Starting...' : 'Start commissioning'}
                </button>
              )}
              {currentStep >= 4 && session && session.status !== 'SUCCEEDED' && (
                <button
                  type="button"
                  onClick={cancelSession}
                  className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 shadow-sm hover:bg-rose-100"
                >
                  Cancel
                </button>
              )}
              {session?.status === 'SUCCEEDED' && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push('/tenant/dashboard')}
                    className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                  >
                    View devices
                  </button>
                  <button
                    type="button"
                    onClick={resetWizard}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                  >
                    Add another
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
