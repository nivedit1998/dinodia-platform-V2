// Architecture: App Router surface src/app/register-admin/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import jsQR from 'jsqr';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { parseApiError } from '@/lib/authClientError';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PhoneNumberInput } from '@/components/auth/PhoneNumberInput';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

const REGISTER_ADMIN_VERIFICATION_KEY = 'register_admin_verification_state';

type HubDetails = {
  dinodiaSerial?: string;
  bootstrapSecret?: string;
};

function parseHubQrPayload(raw: string): HubDetails | null {
  const text = (raw || '').trim();
  if (!text) return null;

  // v3: dinodia://hub?v=3&s=<serial>&bs=<bootstrapSecret>
  if (/^dinodia:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      const serial = parsed.searchParams.get('s') || parsed.searchParams.get('serial');
      const bs = parsed.searchParams.get('bs') || parsed.searchParams.get('bootstrapSecret');
      return {
        dinodiaSerial: serial || undefined,
        bootstrapSecret: bs || undefined,
      };
    } catch {
      // fall through
    }
  }

  // JSON payload fallback (only serial/bootstrap allowed)
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') {
      return {
        dinodiaSerial: data.serial || data.s || undefined,
        bootstrapSecret: data.bootstrapSecret || data.bs || undefined,
      };
    }
  } catch {
    // not JSON
  }

  return null;
}

export default function RegisterAdminPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    username: '',
    password: '',
    email: '',
    phoneCountryIso2: 'GB',
    phoneNationalNumber: '',
    dinodiaSerial: '',
    bootstrapSecret: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [deviceId] = useState(() =>
    typeof window === 'undefined' ? '' : getOrCreateDeviceId()
  );
  const [deviceLabel] = useState(() =>
    typeof window === 'undefined' ? '' : getDeviceLabel()
  );
  const hubDetected = useMemo(
    () => form.dinodiaSerial.trim().length > 0 && form.bootstrapSecret.trim().length > 0,
    [form.dinodiaSerial, form.bootstrapSecret]
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);

  function updateField(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setScanError(null);
  }

  const stopScanner = useCallback(() => {
    setScanning(false);
    setShowScanner(false);
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, [stopScanner]);

  const verification = useEmailVerificationChallenge<{
    email?: string;
    username?: string;
  }>({
    storageKey: REGISTER_ADMIN_VERIFICATION_KEY,
    onApproved: async (id) => {
      if (!deviceId) {
        throw new Error('We could not verify this device right now. Please try again.');
      }

      const data = await platformFetchJson<{
        requiresHomeownerPolicyAcceptance?: boolean;
        completionStatus?: string;
      }>(
        `/api/auth/challenges/${id}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, deviceLabel }),
        },
        'Unsuccessful - please try again.'
      );

      logVerificationCompletionStatusBreadcrumb({
        challengeId: id,
        source: 'register_admin',
        completionStatus: data.completionStatus,
      });

      if (data.requiresHomeownerPolicyAcceptance) {
        router.push('/homeowner/policy');
        return;
      }
      router.push('/admin/dashboard');
    },
    onConsumed: async () => {
      return resumeAuthenticatedSession(router);
    },
    onTerminalStatus: (terminalStatus) => {
      setError(
        terminalStatus === 'EXPIRED'
          ? 'Verification has expired. Please set up the homeowner account again.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Enter your password again to continue.'
            : 'Your previous verification session ended. Enter your password again to continue.'
      );
    },
  });

  const awaitingVerification = verification.waiting && !!verification.challengeId;
  const restoreVerification = verification.restore;

  useEffect(() => {
    void restoreVerification();
  }, [restoreVerification]);

  const handleScanResult = useCallback(
    (raw: string) => {
      const parsed = parseHubQrPayload(raw);
      if (!parsed) {
        setScanError('QR code not recognized. Please scan the Dinodia Hub QR.');
        return;
      }

      setScanError(null);
      if (!parsed.dinodiaSerial || !parsed.bootstrapSecret) {
        setScanError('QR code is missing hub details. Please scan the Dinodia Hub QR.');
      }
      setInfo('Dinodia Hub detected via QR.');
      setForm((prev) => ({
        ...prev,
        dinodiaSerial: (parsed.dinodiaSerial || prev.dinodiaSerial).trim(),
        bootstrapSecret: (parsed.bootstrapSecret || prev.bootstrapSecret).trim(),
      }));
    },
    []
  );

  const scanFrame = useCallback(() => {
    const run = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        frameRef.current = requestAnimationFrame(run);
        return;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, width, height);

      if (code?.data) {
        handleScanResult(code.data);
        stopScanner();
        return;
      }

      frameRef.current = requestAnimationFrame(run);
    };

    run();
  }, [handleScanResult, stopScanner]);

  const startScanner = useCallback(async () => {
    setScanError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanError('Camera is not available in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      streamRef.current = stream;
      setShowScanner(true);
      setScanning(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      frameRef.current = requestAnimationFrame(scanFrame);
    } catch (err) {
      setScanning(false);
      setShowScanner(false);
      setScanError(
        err instanceof Error
          ? err.message
          : 'Unable to access the camera. Please allow camera permissions.'
      );
      stopScanner();
    }
  }, [scanFrame, stopScanner]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!deviceId) {
      setError('Preparing your secure setup details. Please try again in a moment.');
      return;
    }
    if (!form.email) {
      setError('Please enter an admin email.');
      return;
    }
    if (!form.phoneNationalNumber.trim()) {
      setError('Enter a valid phone number.');
      return;
    }
    if (!form.dinodiaSerial.trim() || !form.bootstrapSecret.trim()) {
      setError('Enter the Dinodia serial and bootstrap secret from the installer.');
      return;
    }
    setLoading(true);
    const res = await fetch('/api/auth/register-admin', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username,
        password: form.password,
        email: form.email,
        phoneCountryIso2: form.phoneCountryIso2,
        phoneNumber: form.phoneNationalNumber,
        deviceId,
        deviceLabel,
        dinodiaSerial: form.dinodiaSerial.trim(),
        bootstrapSecret: form.bootstrapSecret.trim(),
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      const parsed = parseApiError(
        data,
        'We couldn’t finish setting up the homeowner account. Please check the details and try again.'
      );
      setError(parsed.message);
      return;
    }

    if (data.challengeId) {
      setInfo('Check your email to verify and finish setup.');
      await verification.start(data.challengeId, {
        email: form.email.trim(),
        username: form.username.trim(),
      });
      return;
    }

    setError('We could not start email approval. Please try again.');
  }

  async function handleResend() {
    if (!verification.challengeId) return;
    setError(null);
    setInfo(null);
    await verification.resend();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card surface="glass" className="w-full max-w-3xl border-white/30 p-6 shadow-lg sm:p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          Set up the homeowner account
        </h1>
        <p className="mt-2 text-center text-sm text-muted">
          For a brand new Dinodia home. Taking over an existing home?{' '}
          <button
            type="button"
            className="font-semibold text-[var(--indigo)] hover:underline"
            onClick={() => router.push('/claim')}
          >
            Claim a home
          </button>
        </p>

        {error || verification.error ? (
          <Card className="mt-5 rounded-[14px] border-[color:var(--danger)] bg-[color:var(--danger)]/12 p-3 text-sm text-foreground">
            {error || verification.error}
          </Card>
        ) : null}
        {info || verification.info ? (
          <Card className="mt-3 rounded-[14px] border-[color:var(--warning)] bg-[color:var(--warning)]/12 p-3 text-sm text-foreground">
            {info || verification.info}
          </Card>
        ) : null}

        {!awaitingVerification ? (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4 text-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Username"
                value={form.username}
                onChange={(e) => updateField('username', e.target.value)}
                required
              />
              <Field
                label="Password"
                type="password"
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                required
              />
              <Field
                label="Homeowner email"
                type="email"
                value={form.email}
                onChange={(e) => updateField('email', e.target.value)}
                required
              />
              <p className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                We’ll send the verification email to {form.email || 'this address'}.
              </p>
              <PhoneNumberInput
                countryIso2={form.phoneCountryIso2}
                phoneNumber={form.phoneNationalNumber}
                onCountryChange={(value) => updateField('phoneCountryIso2', value)}
                onPhoneNumberChange={(value) => updateField('phoneNationalNumber', value)}
                required
              />
              <Field
                label="Dinodia serial number"
                value={form.dinodiaSerial}
                onChange={(e) => updateField('dinodiaSerial', e.target.value)}
                placeholder="DIN-GB-00001234"
                required
              />
              <Field
                label="Bootstrap secret"
                value={form.bootstrapSecret}
                onChange={(e) => updateField('bootstrapSecret', e.target.value)}
                required
              />
            </div>

            <Card surface="muted" className="space-y-3 rounded-[16px] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Dinodia Hub detection
                  </p>
                  <p className="text-xs text-muted">
                    Scan the Dinodia Hub QR code to fill serial and bootstrap details.
                  </p>
                  {hubDetected ? (
                    <p className="mt-1 text-xs text-[var(--success)]">
                      Hub details are loaded.
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant={scanning ? 'danger' : 'secondary'}
                  size="sm"
                  onClick={scanning ? stopScanner : startScanner}
                >
                  {scanning ? 'Stop scanning' : 'Scan Hub QR'}
                </Button>
              </div>

              {scanError ? (
                <div className="rounded-[12px] border border-[color:var(--danger)] bg-[color:var(--danger)]/12 px-3 py-2 text-xs text-foreground">
                  {scanError}
                </div>
              ) : null}

              {showScanner ? (
                <div className="space-y-2 rounded-[14px] border border-border bg-surface p-3">
                  <video
                    ref={videoRef}
                    className="aspect-video w-full rounded-[12px] bg-black"
                    muted
                    playsInline
                  />
                  <canvas ref={canvasRef} className="hidden" />
                  <p className="text-xs text-muted">
                    Point the camera at the Dinodia Hub QR and we will fill details automatically.
                  </p>
                </div>
              ) : null}
            </Card>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" loading={loading} fullWidth>
                {loading ? 'Connecting your hub' : 'Connect your Dinodia Hub'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                fullWidth
                onClick={() => router.push('/login')}
              >
                Back to sign in
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-6 space-y-3 text-sm">
            <p className="text-foreground">
              Open your email and approve this device. We will complete setup here.
            </p>
            <Card surface="muted" className="rounded-[14px] p-3 text-xs text-muted">
              <div className="font-semibold text-foreground">Status</div>
              <div>{verification.status ?? 'Waiting for approval...'}</div>
            </Card>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={handleResend}>
                Resend email
              </Button>
              {verification.manualRetryAvailable ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => void verification.retryCompletionNow()}
                >
                  Finish setup
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  verification.reset();
                  setError(null);
                  setInfo(null);
                }}
              >
                Start over
              </Button>
            </div>
            {verification.completing ? (
              <p className="text-xs text-muted">Finalizing secure setup...</p>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}
