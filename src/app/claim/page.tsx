// Architecture: App Router surface src/app/claim/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { HomeStatus } from '@prisma/client';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { parseApiError } from '@/lib/authClientError';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { PhoneNumberInput } from '@/components/auth/PhoneNumberInput';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

const CLAIM_HOME_VERIFICATION_KEY = 'claim_home_verification_state';

type ClaimContext = {
  homeStatus: HomeStatus | null;
};

export default function ClaimHomePage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [claimCode, setClaimCode] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoverySerial, setRecoverySerial] = useState('');
  const [recoverySecret, setRecoverySecret] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [claimContext, setClaimContext] = useState<ClaimContext | null>(null);
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    email: '',
    phoneCountryIso2: 'GB',
    phoneNationalNumber: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deviceId] = useState(() =>
    typeof window === 'undefined' ? '' : getOrCreateDeviceId()
  );
  const [deviceLabel] = useState(() =>
    typeof window === 'undefined' ? '' : getDeviceLabel()
  );

  function updateField(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function formatClaimCode(input: string) {
    const raw = input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 15);
    const parts = [
      raw.slice(0, 3),
      raw.slice(3, 7),
      raw.slice(7, 11),
      raw.slice(11, 15),
    ].filter((part) => part.length > 0);
    return parts.join('-');
  }

  const verification = useEmailVerificationChallenge<{
    claimCode?: string;
    email?: string;
  }>({
    storageKey: CLAIM_HOME_VERIFICATION_KEY,
    onApproved: async (id) => {
      if (!deviceId) {
        throw new Error('Device information missing. Please try again.');
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
        'Verification failed. Please try again.'
      );

      logVerificationCompletionStatusBreadcrumb({
        challengeId: id,
        source: 'claim_home',
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
          ? 'Verification expired. Submit again to claim this home.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Submit again if you still need to claim this home.'
            : 'Your previous verification session ended. Submit again to continue.'
      );
    },
  });

  const awaitingVerification = verification.waiting && !!verification.challengeId;
  const restoreVerification = verification.restore;

  function resetFlow() {
    setStep(1);
    setClaimContext(null);
    setClaimCode('');
    setForm({
      username: '',
      password: '',
      confirmPassword: '',
      email: '',
      phoneCountryIso2: 'GB',
      phoneNationalNumber: '',
    });
    setError(null);
    setInfo(null);
    setCheckingCode(false);
    setSubmitting(false);
    verification.reset();
  }

  useEffect(() => {
    void restoreVerification();
  }, [restoreVerification]);

  async function validateClaimCodeFlow(trimmedCode: string) {
    setError(null);
    setInfo(null);

    if (!trimmedCode) {
      setError('Enter the claim code to continue.');
      return;
    }

    setCheckingCode(true);
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: trimmedCode, validateOnly: true }),
    });
    const data = await res.json();
    setCheckingCode(false);

    if (!res.ok) {
      const parsed = parseApiError(data, 'We could not validate that claim code.');
      setError(parsed.message);
      setClaimContext(null);
      return;
    }

    setClaimContext({
      homeStatus: data.homeStatus ?? null,
    });
    setStep(2);
    setInfo('Claim code accepted. Create your admin account to continue.');
  }

  async function handleValidateClaimCode(e: React.FormEvent) {
    e.preventDefault();
    await validateClaimCodeFlow(claimCode.trim());
  }

  async function handleRecoverClaimCode() {
    if (recovering) return;
    setError(null);
    setInfo(null);
    const serial = recoverySerial.trim();
    const bootstrapSecret = recoverySecret.trim();
    if (!serial || !bootstrapSecret) {
      setError('Enter your hub serial and bootstrap secret.');
      return;
    }
    setRecovering(true);
    try {
      const res = await fetch('/api/claim/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial, bootstrapSecret }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parsed = parseApiError(data, 'We could not generate a claim code. Please try again.');
        setError(parsed.message);
        return;
      }
      if (!data.claimCode || typeof data.claimCode !== 'string') {
        setError('We could not generate a claim code. Please try again.');
        return;
      }
      setClaimCode(data.claimCode);
      setShowRecovery(false);
      await validateClaimCodeFlow(String(data.claimCode).trim());
    } finally {
      setRecovering(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!claimContext) {
      setError('Validate the claim code first.');
      setStep(1);
      return;
    }
    if (!deviceId) {
      setError('Preparing your device info. Try again in a moment.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords must match.');
      return;
    }
    if (!form.email.trim()) {
      setError('Please enter an admin email.');
      return;
    }
    if (!form.phoneNationalNumber.trim()) {
      setError('Enter a valid phone number.');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimCode: claimCode.trim(),
        username: form.username,
        password: form.password,
        email: form.email,
        phoneCountryIso2: form.phoneCountryIso2,
        phoneNumber: form.phoneNationalNumber,
        deviceId,
        deviceLabel,
      }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      const parsed = parseApiError(
        data,
        'We could not start the claim. Please review the details and try again.'
      );
      setError(parsed.message);
      if (res.status === 404 || res.status === 409) {
        setClaimContext(null);
        setStep(1);
      }
      return;
    }

    if (data.challengeId) {
      setInfo('Check your email to verify and finish claiming this home.');
      await verification.start(data.challengeId, {
        claimCode: claimCode.trim(),
        email: form.email.trim(),
      });
      return;
    }

    setError('We could not start email verification. Please try again.');
  }

  async function handleResend() {
    if (!verification.challengeId) return;
    setError(null);
    setInfo(null);
    await verification.resend();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl bg-white shadow-lg rounded-2xl p-8">
        <h1 className="text-2xl font-semibold mb-2 text-center">
          Claim this home
        </h1>
        <p className="text-center text-sm text-slate-600 mb-6">
          Use the claim code from the previous homeowner to create your admin account.
        </p>

        {(error || verification.error) && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error || verification.error}
          </div>
        )}
        {(info || verification.info) && (
          <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            {info || verification.info}
          </div>
        )}

        {!awaitingVerification && step === 1 && (
          <form onSubmit={handleValidateClaimCode} className="space-y-4 text-sm">
            <div>
              <label className="block font-medium mb-1">Claim code</label>
                <input
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={claimCode}
                  onChange={(e) => setClaimCode(formatClaimCode(e.target.value))}
                  placeholder="DND-1234-5678-ABCD"
                  required
                />
            </div>
            <button
              type="submit"
              disabled={checkingCode}
              className="w-full bg-indigo-600 text-white rounded-lg py-2 font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {checkingCode ? 'Checking claim code…' : 'Continue'}
            </button>
            <button
              type="button"
              onClick={() => setShowRecovery((v) => !v)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Lost claim code?
            </button>
            {showRecovery && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="text-xs text-slate-600">
                  Scan your Dinodia Hub QR code to find the serial + bootstrap secret.
                </div>
                <div>
                  <label className="block font-medium mb-1">Hub serial</label>
                  <input
                    className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                    value={recoverySerial}
                    onChange={(e) => setRecoverySerial(e.target.value)}
                    placeholder="DIN-XXXX-0001"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Bootstrap secret</label>
                  <input
                    type="password"
                    className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                    value={recoverySecret}
                    onChange={(e) => setRecoverySecret(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="button"
                  disabled={recovering}
                  onClick={handleRecoverClaimCode}
                  className="w-full bg-slate-900 text-white rounded-lg py-2 font-medium hover:bg-slate-800 disabled:opacity-50"
                >
                  {recovering ? 'Generating…' : 'Generate new claim code'}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to Login
            </button>
          </form>
        )}

        {!awaitingVerification && step === 2 && claimContext && (
          <form onSubmit={handleSubmit} className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-medium mb-1">Portal username</label>
                <input
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.username}
                  onChange={(e) => updateField('username', e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Portal password</label>
                <input
                  type="password"
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.password}
                  onChange={(e) => updateField('password', e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-medium mb-1">Confirm password</label>
                <input
                  type="password"
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.confirmPassword}
                  onChange={(e) => updateField('confirmPassword', e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Admin email</label>
                <input
                  type="email"
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Verification will be sent to {form.email || 'this email'}.
              </div>
              <div>
                <label className="block font-medium mb-1">Home status</label>
                <input
                  className="w-full border rounded-lg px-3 py-2 bg-slate-50 text-slate-700"
                  value={claimContext.homeStatus ?? 'Pending'}
                  readOnly
                />
              </div>
            </div>

            <PhoneNumberInput
              countryIso2={form.phoneCountryIso2}
              phoneNumber={form.phoneNationalNumber}
              onCountryChange={(value) => updateField('phoneCountryIso2', value)}
              onPhoneNumberChange={(value) => updateField('phoneNationalNumber', value)}
              required
            />

            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-2 bg-indigo-600 text-white rounded-lg py-2 font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? 'Starting claim…' : 'Send verification email'}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setClaimContext(null);
                  setInfo(null);
                  setError(null);
                }}
                className="flex-1 rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Change claim code
              </button>
              <button
                type="button"
                onClick={() => router.push('/login')}
                className="flex-1 rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Back to Login
              </button>
            </div>
          </form>
        )}

        {awaitingVerification && (
          <div className="space-y-3 text-sm">
            <p className="text-slate-700">
              Check your email and click the verification link. We’ll finish creating your admin
              session on this device after approval.
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <div className="font-medium text-slate-700">Status</div>
              <div>{verification.status ?? 'Waiting for approval…'}</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleResend}
                className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
              >
                Resend email
              </button>
              {verification.manualRetryAvailable && (
                <button
                  onClick={() => void verification.retryCompletionNow()}
                  className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
                >
                  Finish claim
                </button>
              )}
              <button
                onClick={resetFlow}
                className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
              >
                Start over
              </button>
            </div>
            {verification.completing && (
              <p className="text-xs text-slate-500">Finishing setup…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
