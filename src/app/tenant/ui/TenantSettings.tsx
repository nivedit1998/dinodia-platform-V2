// Architecture: App Router surface src/app/tenant/ui/TenantSettings.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { logout as performLogout } from '@/lib/logout';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

type Props = {
  username: string;
};

type StatusMessage = { type: 'success' | 'error'; message: string } | null;
type TwoFaStatus = {
  email: string | null;
  emailPending: string | null;
  emailVerifiedAt: string | null;
  email2faEnabled: boolean;
};

type TwoFaVerificationState = {
  email: string;
};

const EMPTY_FORM = {
  currentPassword: '',
  newPassword: '',
  confirmNewPassword: '',
};

const EMPTY_TWO_FA_FORM = {
  email: '',
  confirmEmail: '',
};

const ALEXA_SKILL_URL = 'https://www.amazon.co.uk/gp/product/B0GGCC4BDS?nodl=0';
const TENANT_SETTINGS_2FA_VERIFICATION_KEY = 'tenant_settings_2fa_verification_state';

export default function TenantSettings({ username }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [alert, setAlert] = useState<StatusMessage>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [alexaLinkVisible, setAlexaLinkVisible] = useState(false);
  const [passwordSectionOpen, setPasswordSectionOpen] = useState(false);
  const [twoFaSectionOpen, setTwoFaSectionOpen] = useState(false);
  const [twoFaForm, setTwoFaForm] = useState(EMPTY_TWO_FA_FORM);
  const [twoFaAlert, setTwoFaAlert] = useState<StatusMessage>(null);
  const [twoFaStatus, setTwoFaStatus] = useState<TwoFaStatus | null>(null);
  const [twoFaStatusLoading, setTwoFaStatusLoading] = useState(false);
  const [twoFaSubmitting, setTwoFaSubmitting] = useState(false);
  const deviceIdRef = useRef<string | null>(null);
  const deviceLabelRef = useRef<string | null>(null);
  const [areaSectionOpen, setAreaSectionOpen] = useState(false);
  const [roomQr, setRoomQr] = useState<string>('');
  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomScanError, setRoomScanError] = useState<string | null>(null);
  const [roomRequestMsg, setRoomRequestMsg] = useState<StatusMessage>(null);
  const [roomRequestLoading, setRoomRequestLoading] = useState(false);
  const [roomScanning, setRoomScanning] = useState(false);
  const [roomScanningError, setRoomScanningError] = useState<string | null>(null);
  const roomVideoRef = useRef<HTMLVideoElement | null>(null);
  const roomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const roomAnimationRef = useRef<number | null>(null);
  const roomStreamRef = useRef<MediaStream | null>(null);

  function updateField(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateTwoFaField(key: keyof typeof twoFaForm, value: string) {
    setTwoFaForm((prev) => ({ ...prev, [key]: value }));
  }

  const refreshTwoFaStatus = useCallback(async () => {
    setTwoFaStatusLoading(true);
    try {
      const data = await platformFetchJson<TwoFaStatus>(
        '/api/tenant/profile/2fa/status',
        {
          cache: 'no-store',
          credentials: 'include',
        },
        'Unable to load verification status.'
      );
      setTwoFaStatus(data);
      return data;
    } catch (err) {
      setTwoFaAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'Unable to load verification status.'),
      });
      return null;
    } finally {
      setTwoFaStatusLoading(false);
    }
  }, []);

  const verification = useEmailVerificationChallenge<TwoFaVerificationState>({
    storageKey: TENANT_SETTINGS_2FA_VERIFICATION_KEY,
    onApproved: async (id) => {
      const deviceId = deviceIdRef.current ?? getOrCreateDeviceId();
      const deviceLabel = deviceLabelRef.current ?? getDeviceLabel();
      deviceIdRef.current = deviceId;
      deviceLabelRef.current = deviceLabel;

      await platformFetchJson<{ ok: boolean }>(
        '/api/tenant/profile/2fa/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: id, deviceId, deviceLabel }),
        },
        'Unable to finish verification.'
      );

      setTwoFaAlert({
        type: 'success',
        message: 'Email verification enabled. This device is trusted.',
      });
      await refreshTwoFaStatus();
    },
    onConsumed: async () => {
      const latest = await refreshTwoFaStatus();
      if (latest?.email2faEnabled && latest.emailVerifiedAt) {
        setTwoFaAlert({
          type: 'success',
          message: 'Email verification is already complete. This device is trusted.',
        });
        return true;
      }
      return false;
    },
    onTerminalStatus: (terminalStatus) => {
      const statusMessage =
        terminalStatus === 'CONSUMED'
          ? 'This verification link was already used.'
          : terminalStatus === 'NOT_FOUND'
            ? 'Verification request not found.'
            : 'The verification link expired. Please try again.';
      setTwoFaAlert({
        type: 'error',
        message: statusMessage,
      });
    },
  });
  const restoreTwoFaVerification = verification.restore;

  const stopRoomScan = useCallback(() => {
    setRoomScanning(false);
    if (roomAnimationRef.current) cancelAnimationFrame(roomAnimationRef.current);
    roomAnimationRef.current = null;
    if (roomStreamRef.current) {
      roomStreamRef.current.getTracks().forEach((t) => t.stop());
      roomStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopRoomScan();
    };
  }, [stopRoomScan]);

  const scanRoomQr = useCallback(async (payload: string) => {
    setRoomScanError(null);
    setRoomRequestMsg(null);
    setRoomName(null);
    setRoomQr(payload);
    try {
      const data = await platformFetchJson<{ room?: { displayName?: string } }>(
        '/api/public/rooms/scan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr: payload }),
        },
        'Unable to scan this room QR right now.'
      );
      const displayName = typeof data?.room?.displayName === 'string' ? data.room.displayName : '';
      setRoomName(displayName || null);
    } catch (err) {
      setRoomScanError(friendlyUnknownError(err, 'Unable to scan this room QR right now.'));
    }
  }, []);

  const startRoomScan = useCallback(async () => {
    setRoomScanningError(null);
    if (!roomVideoRef.current || !roomCanvasRef.current) {
      setRoomScanningError('Scanner is not ready yet.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      roomStreamRef.current = stream;
      roomVideoRef.current.srcObject = stream;
      await roomVideoRef.current.play();
      setRoomScanning(true);

      const loop = () => {
        const video = roomVideoRef.current;
        const canvas = roomCanvasRef.current;
        if (!video || !canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, canvas.width, canvas.height);
          if (code?.data) {
            stopRoomScan();
            void scanRoomQr(code.data);
            return;
          }
        }
        roomAnimationRef.current = requestAnimationFrame(loop);
      };

      roomAnimationRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setRoomScanningError(err instanceof Error ? err.message : 'Unable to start camera scan.');
      stopRoomScan();
    }
  }, [scanRoomQr, stopRoomScan]);

  const decodeRoomQrFromFile = useCallback(
    async (file: File | null) => {
      setRoomScanningError(null);
      if (!file) return;
      const img = document.createElement('img');
      const url = URL.createObjectURL(file);
      img.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Unable to load image.'));
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        setRoomScanningError(err instanceof Error ? err.message : 'Unable to load image.');
        return;
      }
      URL.revokeObjectURL(url);

      const canvas = roomCanvasRef.current;
      if (!canvas) {
        setRoomScanningError('Scanner is not ready yet.');
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setRoomScanningError('Unable to read image.');
        return;
      }
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, canvas.width, canvas.height);
      if (!code?.data) {
        setRoomScanningError('No QR code detected in the image.');
        return;
      }
      void scanRoomQr(code.data);
    },
    [scanRoomQr]
  );

  const submitRoomAccessRequest = useCallback(async () => {
    setRoomRequestMsg(null);
    setRoomScanError(null);
    if (!roomQr.trim()) {
      setRoomRequestMsg({ type: 'error', message: 'Scan the room QR code first.' });
      return;
    }
    setRoomRequestLoading(true);
    try {
      await platformFetchJson<{ ok?: boolean }>(
        '/api/tenant/rooms/request-access',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr: roomQr }),
        },
        'Unable to request access right now.'
      );
      setRoomRequestMsg({
        type: 'success',
        message: 'Request sent. The homeowner or property manager will review your request by email.',
      });
    } catch (err) {
      setRoomRequestMsg({
        type: 'error',
        message: friendlyUnknownError(err, 'Unable to request access right now.'),
      });
    } finally {
      setRoomRequestLoading(false);
    }
  }, [roomQr]);

  async function handleTwoFaStart(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTwoFaAlert(null);
    const deviceId = deviceIdRef.current ?? getOrCreateDeviceId();
    const deviceLabel = deviceLabelRef.current ?? getDeviceLabel();
    deviceIdRef.current = deviceId;
    deviceLabelRef.current = deviceLabel;

    if (!deviceId) {
      setTwoFaAlert({
        type: 'error',
        message: 'We need device info to continue. Please try again.',
      });
      return;
    }

    setTwoFaSubmitting(true);
    try {
      const data = await platformFetchJson<{ alreadyEnabled?: boolean; challengeId?: string }>(
        '/api/tenant/profile/2fa/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: twoFaForm.email,
            confirmEmail: twoFaForm.confirmEmail,
            deviceId,
            deviceLabel,
          }),
        },
        'Unable to start verification.'
      );
      if (data.alreadyEnabled) {
        verification.reset();
        setTwoFaAlert({ type: 'success', message: 'Two-factor authentication is already on.' });
        await refreshTwoFaStatus();
        return;
      }
      if (!data.challengeId) {
        throw new Error('Unable to start verification.');
      }

      setTwoFaAlert({
        type: 'success',
        message: 'Check your email for a verification link to finish enabling 2FA.',
      });
      await refreshTwoFaStatus();
      await verification.start(data.challengeId, { email: twoFaForm.email.trim() });
    } catch (err) {
      setTwoFaAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'Unable to start verification.'),
      });
    } finally {
      setTwoFaSubmitting(false);
    }
  }

  async function handleResendEmail() {
    setTwoFaAlert(null);
    await verification.resend();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAlert(null);

    if (form.newPassword !== form.confirmNewPassword) {
      setAlert({ type: 'error', message: 'New passwords do not match' });
      return;
    }

    setLoading(true);
    try {
      await platformFetchJson<{ ok: boolean }>(
        '/api/tenant/profile/change-password',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        },
        'Unable to update password.'
      );
      setAlert({ type: 'success', message: 'Password updated successfully' });
      setForm(EMPTY_FORM);
    } catch (err) {
      setAlert({
        type: 'error',
        message: friendlyUnknownError(err, 'Unable to update password.'),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await performLogout();
  }

  useEffect(() => {
    deviceIdRef.current = getOrCreateDeviceId();
    deviceLabelRef.current = getDeviceLabel();
    void (async () => {
      await refreshTwoFaStatus();
      const restored = await restoreTwoFaVerification();
      if (restored?.email) {
        setTwoFaForm((prev) => ({
          ...prev,
          email: restored.email,
          confirmEmail: restored.email,
        }));
      }
    })();
  }, [refreshTwoFaStatus, restoreTwoFaVerification]);

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
          'Unable to load devices.'
        );
        if (!active) return;
        const devices = Array.isArray(data.devices) ? data.devices : [];
        setAlexaLinkVisible(devices.length > 0);
      } catch {
        if (active) {
          setAlexaLinkVisible(false);
        }
      }
    }
    void checkAlexaDevices();
    return () => {
      active = false;
    };
  }, []);

  const pendingEmail = twoFaStatus?.emailPending || verification.currentState?.email || twoFaForm.email;
  const challengeStatusCopy = (() => {
    switch (verification.status) {
      case 'PENDING':
        return 'Waiting for you to approve the email link.';
      case 'APPROVED':
        return 'Approved. Finishing setup…';
      case 'EXPIRED':
        return 'Link expired. Start again.';
      case 'CONSUMED':
        return 'This link was already used.';
      case 'NOT_FOUND':
        return 'Verification request not found.';
      default:
        return '';
    }
  })();
  const verifiedEmail = twoFaStatus?.email || pendingEmail || 'Email pending';

  return (
    <div className="min-h-screen bg-[#f5f5f7] px-3 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-3xl bg-white rounded-2xl shadow-lg p-4 sm:p-6 flex flex-col gap-4">
        <header className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 sm:items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 shadow-sm">
              <Image
                src="/brand/logo-mark.png"
                alt="Dinodia"
                width={40}
                height={40}
                priority
              />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-snug">Tenant Settings</h1>
            <p className="text-xs text-slate-500">
              Logged in as <span className="font-medium">{username}</span>
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
            <div className="absolute right-0 mt-2 w-48 rounded-xl border border-slate-100 bg-white/95 p-1 text-sm text-slate-700 shadow-lg backdrop-blur">
              <Link
                href="/tenant/dashboard"
                className="flex items-center gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                onClick={() => setMenuOpen(false)}
              >
                Go back to Dashboard
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
                  void handleLogout();
                }}
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="text-sm border border-slate-200 rounded-xl">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left font-semibold"
          onClick={() => setAreaSectionOpen((prev) => !prev)}
        >
          <span>Add new area</span>
          <span className="text-xs font-normal text-slate-500">{areaSectionOpen ? 'Hide' : 'Show'}</span>
        </button>
        {areaSectionOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-3">
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-2">
                <div className="flex items-center justify-between pb-2">
                  <p className="text-xs font-semibold text-slate-700">Camera scan</p>
                  <button
                    type="button"
                    onClick={() => (roomScanning ? stopRoomScan() : void startRoomScan())}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {roomScanning ? 'Stop' : 'Start'}
                  </button>
                </div>
                <video ref={roomVideoRef} className="h-40 w-full rounded-lg object-cover" muted playsInline />
                {roomScanningError ? <p className="mt-2 text-xs text-rose-600">{roomScanningError}</p> : null}
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs font-semibold text-slate-700">Upload QR image</p>
                <input
                  type="file"
                  accept="image/*"
                  className="mt-2 w-full text-xs"
                  onChange={(e) => void decodeRoomQrFromFile(e.target.files?.[0] ?? null)}
                />
                <p className="mt-2 text-[11px] text-slate-500">If scanning doesn&apos;t work, upload a photo of the QR.</p>
              </div>
            </div>
            <canvas ref={roomCanvasRef} className="hidden" />

            {roomName ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Room</p>
                <p className="text-sm font-semibold text-slate-900">{roomName}</p>
              </div>
            ) : null}

            {roomScanError ? <p className="text-xs text-rose-600">{roomScanError}</p> : null}
            {roomRequestMsg ? (
              <p className={`text-xs ${roomRequestMsg.type === 'success' ? 'text-emerald-700' : 'text-rose-600'}`}>
                {roomRequestMsg.message}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => void submitRoomAccessRequest()}
              disabled={roomRequestLoading}
              className="bg-indigo-600 text-white rounded-lg py-2 px-4 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {roomRequestLoading ? 'Requesting…' : 'Request access'}
            </button>
          </div>
        )}
      </section>

      <section className="text-sm border border-slate-200 rounded-xl">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left font-semibold"
          onClick={() => setPasswordSectionOpen((prev) => !prev)}
        >
          <span>Change password</span>
          <span className="text-xs font-normal text-slate-500">
            {passwordSectionOpen ? 'Hide' : 'Show'}
          </span>
        </button>
        {passwordSectionOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-slate-100">
            <form onSubmit={handleSubmit} className="space-y-3 mt-3">
              <div>
                <label className="block mb-1 text-xs">Current password</label>
                <input
                  type="password"
                  className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.currentPassword}
                  onChange={(e) => updateField('currentPassword', e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="block mb-1 text-xs">New password</label>
                  <input
                    type="password"
                    className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.newPassword}
                    onChange={(e) => updateField('newPassword', e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-xs">Confirm new password</label>
                  <input
                    type="password"
                    className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    value={form.confirmNewPassword}
                    onChange={(e) => updateField('confirmNewPassword', e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Minimum 8 characters. If you can&apos;t access your account, ask the homeowner who set up Dinodia to help.
              </p>
              <button
                type="submit"
                disabled={loading}
                className="bg-indigo-600 text-white rounded-lg py-2 px-4 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
            {alert && (
              <p
                className={`mt-2 text-xs ${
                  alert.type === 'success' ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {alert.message}
              </p>
            )}
          </div>
        )}
      </section>
      <section className="text-sm border border-slate-200 rounded-xl">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left font-semibold"
          onClick={() => setTwoFaSectionOpen((prev) => !prev)}
        >
          <span>Two-factor authentication</span>
          <span className="text-xs font-normal text-slate-500">
            {twoFaSectionOpen ? 'Hide' : 'Show'}
          </span>
        </button>
        {twoFaSectionOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-slate-100 space-y-3">
            {twoFaStatusLoading ? (
              <p className="text-xs text-slate-500">Checking your 2FA status…</p>
            ) : twoFaStatus?.email2faEnabled && twoFaStatus.emailVerifiedAt ? (
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-emerald-900">
                <p className="text-xs font-semibold">2FA enabled</p>
                <p className="text-[11px] mt-1">
                  Verification email:{' '}
                  <span className="font-medium">{verifiedEmail}</span>
                </p>
                <p className="text-[11px] text-emerald-800/80 mt-1">
                  This device is trusted. New devices will need email approval.
                </p>
              </div>
            ) : (
              <>
                <p className="text-[11px] text-slate-600">
                  Verify your email to secure new devices. We&apos;ll trust this browser after you finish.
                </p>
                <form onSubmit={handleTwoFaStart} className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="block mb-1 text-xs">Email</label>
                      <input
                        type="email"
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={twoFaForm.email}
                        onChange={(e) => updateTwoFaField('email', e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-xs">Confirm email</label>
                      <input
                        type="email"
                        className="w-full border rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                        value={twoFaForm.confirmEmail}
                        onChange={(e) => updateTwoFaField('confirmEmail', e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={twoFaSubmitting}
                    className="bg-indigo-600 text-white rounded-lg py-2 px-4 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {twoFaSubmitting ? 'Sending…' : 'Send verification email'}
                  </button>
                </form>
                {verification.waiting && verification.challengeId && (
                  <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-indigo-900">
                    <p className="text-xs font-semibold">Check your email</p>
                    <p className="text-[11px] mt-1">
                      We sent a verification link to <span className="font-medium">{pendingEmail || 'your email'}</span>.
                    </p>
                    {challengeStatusCopy && (
                      <p className="text-[11px] mt-1">Status: {challengeStatusCopy}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleResendEmail()}
                        className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                      >
                        Resend email
                      </button>
                      {verification.manualRetryAvailable ? (
                        <button
                          type="button"
                          onClick={() => void verification.retryCompletionNow()}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                        >
                          Finish setup
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          verification.reset();
                          setTwoFaAlert(null);
                        }}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Use a different email
                      </button>
                    </div>
                    {verification.completing ? (
                      <p className="text-[11px] mt-2 text-indigo-900/75">Finishing setup…</p>
                    ) : null}
                  </div>
                )}
              </>
            )}
            {twoFaAlert && (
              <p
                className={`text-xs ${
                  twoFaAlert.type === 'success' ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {twoFaAlert.message}
              </p>
            )}
          </div>
        )}
      </section>
      {alexaLinkVisible && (
        <section className="text-sm border border-indigo-100 rounded-xl p-4 bg-indigo-50 text-indigo-900">
          <h2 className="font-semibold mb-2">
            Connect all your Dinodia smart home devices to Alexa!
          </h2>
          <p className="text-[11px] text-indigo-900/80">
            Link your account with the Dinodia Smart Living skill to control your devices
            hands-free from the Alexa app or any Echo speaker.
          </p>
          <a
            href={ALEXA_SKILL_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
          >
            Open Dinodia in Alexa
          </a>
        </section>
      )}
      </div>
    </div>
  );
}
