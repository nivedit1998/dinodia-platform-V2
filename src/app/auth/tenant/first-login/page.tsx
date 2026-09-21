// Architecture: App Router surface src/app/auth/tenant/first-login/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { friendlyErrorFromUnknown, parseApiError } from '@/lib/authClientError';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { PhoneNumberInput } from '@/components/auth/PhoneNumberInput';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

type FirstLoginState = {
  loginIntentId: string;
  deviceId?: string;
  deviceLabel?: string;
  needsEmailInput?: boolean;
};

type PendingVerificationState = FirstLoginState & {
  email?: string;
  phoneCountryIso2: string;
  phoneNumber: string;
};

const TENANT_FIRST_LOGIN_KEY = 'tenant_first_login_state';
const TENANT_FIRST_LOGIN_VERIFICATION_KEY = 'tenant_first_login_verification_state';

export default function TenantFirstLoginPage() {
  const router = useRouter();
  const [state, setState] = useState<FirstLoginState | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [email, setEmail] = useState('');
  const [phoneCountryIso2, setPhoneCountryIso2] = useState('GB');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const needsEmailInput = Boolean(state?.needsEmailInput);

  const clearSavedState = useCallback(() => {
    try {
      sessionStorage.removeItem(TENANT_FIRST_LOGIN_KEY);
    } catch {
      // ignore
    }
  }, []);

  const loadState = useCallback((): FirstLoginState | null => {
    try {
      const raw = sessionStorage.getItem(TENANT_FIRST_LOGIN_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FirstLoginState;
      if (parsed && parsed.loginIntentId) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const saveState = useCallback((value: FirstLoginState) => {
    try {
      sessionStorage.setItem(TENANT_FIRST_LOGIN_KEY, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, []);

  const verification = useEmailVerificationChallenge<PendingVerificationState>({
    storageKey: TENANT_FIRST_LOGIN_VERIFICATION_KEY,
    onApproved: async (id, currentState) => {
      const deviceId = currentState?.deviceId || getOrCreateDeviceId();
      const deviceLabel = currentState?.deviceLabel || getDeviceLabel();
      if (!deviceId) {
        throw new Error('We could not verify this device right now. Please try again.');
      }

      const data = await platformFetchJson<{ ok?: boolean; completionStatus?: string }>(
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
        source: 'tenant_first_login_auth',
        completionStatus: data.completionStatus,
      });

      clearSavedState();
      router.push('/tenant/dashboard');
    },
    onConsumed: async () => {
      const resumed = await resumeAuthenticatedSession(router);
      if (resumed) clearSavedState();
      return resumed;
    },
    onTerminalStatus: (terminalStatus) => {
      setError(
        terminalStatus === 'EXPIRED'
          ? 'The verification link expired. Please submit again.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Please submit again on this device.'
            : 'Verification request not found. Please submit again.'
      );
    },
  });

  const awaitingVerification = verification.waiting && !!verification.challengeId;
  const restoreVerification = verification.restore;

  const statusCopy = useMemo(() => {
    switch (verification.status) {
      case 'PENDING':
        return 'Waiting for you to approve the email link.';
      case 'APPROVED':
        return 'Approved. Finishing sign-in…';
      case 'EXPIRED':
        return 'Link expired. Please send a new one.';
      case 'CONSUMED':
        return 'This link was already used.';
      case 'NOT_FOUND':
        return 'Verification request not found.';
      default:
        return '';
    }
  }, [verification.status]);

  const backToLogin = useCallback(() => {
    verification.reset();
    clearSavedState();
    router.push('/login');
  }, [clearSavedState, router, verification]);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const saved = loadState();
      if (!saved) return;

      const withDevice =
        saved.deviceId && saved.deviceLabel
          ? saved
          : {
              ...saved,
              deviceId: getOrCreateDeviceId(),
              deviceLabel: getDeviceLabel(),
            };

      if (cancelled) return;
      setState(withDevice);
      saveState(withDevice);

      const restored = await restoreVerification();
      if (cancelled || !restored) return;
      setState(restored);
      setEmail(restored.email || '');
      setPhoneCountryIso2(restored.phoneCountryIso2 || 'GB');
      setPhoneNumber(restored.phoneNumber || '');
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [loadState, restoreVerification, saveState]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setInfo(null);

      const current = state ?? loadState();
      if (!current) {
        setError('Your login session expired. Please log in again.');
        return;
      }
      if (!newPassword || !confirmNewPassword) {
        setError('Please enter a new password.');
        return;
      }
      if (newPassword !== confirmNewPassword) {
        setError('New passwords must match.');
        return;
      }

      const trimmedEmail = email.trim();
      const trimmedPhone = phoneNumber.trim();

      if (needsEmailInput && !trimmedEmail) {
        setError('Please enter your email.');
        return;
      }
      if (!trimmedPhone) {
        setError('Enter a valid phone number.');
        return;
      }

      const nextState: PendingVerificationState = {
        ...current,
        deviceId: current.deviceId || getOrCreateDeviceId(),
        deviceLabel: current.deviceLabel || getDeviceLabel(),
        email: trimmedEmail || undefined,
        phoneCountryIso2,
        phoneNumber: trimmedPhone,
      };

      setState(nextState);
      saveState(nextState);
      setLoading(true);

      try {
        const res = await fetch(`/api/auth/login-intents/${current.loginIntentId}/continue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            newPassword,
            confirmNewPassword,
            ...(needsEmailInput ? { email: trimmedEmail } : {}),
            phoneCountryIso2,
            phoneNumber: trimmedPhone,
            deviceId: nextState.deviceId,
            deviceLabel: nextState.deviceLabel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(parseApiError(data, 'We could not finish setup. Please try again.').message);
        }

        if (data.requiresEmailVerification && data.challengeId) {
          setInfo('Check your email to approve this device.');
          await verification.start(data.challengeId, nextState);
          return;
        }

        if (data.role === 'TENANT') {
          verification.reset();
          clearSavedState();
          router.push('/tenant/dashboard');
          return;
        }

        throw new Error('Unexpected response. Please try again.');
      } catch (err) {
        setError(friendlyErrorFromUnknown(err, 'We could not finish setup. Please try again.'));
      } finally {
        setLoading(false);
      }
    },
    [
      clearSavedState,
      confirmNewPassword,
      email,
      loadState,
      needsEmailInput,
      newPassword,
      phoneCountryIso2,
      phoneNumber,
      router,
      saveState,
      state,
      verification,
    ]
  );

  const handleResend = useCallback(async () => {
    setError(null);
    setInfo(null);
    await verification.resend();
  }, [verification]);

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
          <h1 className="text-xl font-semibold text-slate-900">First time setup</h1>
          <p className="mt-2 text-sm text-slate-600">
            We couldn&apos;t find your login details. Please start from the login page.
          </p>
          <button
            type="button"
            className="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
            onClick={backToLogin}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  const pendingEmailCopy = verification.currentState?.email || email;

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl rounded-2xl bg-white p-8 shadow-xl ring-1 ring-slate-100">
        <h1 className="text-2xl font-semibold text-slate-900">First time setup</h1>
        <p className="mt-1 text-sm text-slate-600">
          Your homeowner set a temporary password. Set a new one and verify your email to continue.
        </p>

        {(error || verification.error) && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error || verification.error}
          </div>
        )}
        {(info || verification.info) && (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {info || verification.info}
          </div>
        )}

        {!awaitingVerification ? (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
                Step 1 · New password
              </p>
              <div>
                <label className="block text-sm font-medium text-slate-800">New password</label>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-800">Confirm new password</label>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
                Step 2 · Verify email
              </p>
              {needsEmailInput ? (
                <div>
                  <label className="block text-sm font-medium text-slate-800">Email</label>
                  <input
                    type="email"
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    This must match the email your homeowner used when creating your account.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-700">
                  We’ll send a verification link to the email address on your account.
                </p>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
                Step 3 · Phone number
              </p>
              <PhoneNumberInput
                countryIso2={phoneCountryIso2}
                phoneNumber={phoneNumber}
                onCountryChange={setPhoneCountryIso2}
                onPhoneNumberChange={setPhoneNumber}
                required
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-60"
              >
                {loading ? 'Working…' : 'Finish setup'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={backToLogin}
              >
                Back to login
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-6 space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-4">
            <p className="text-sm text-slate-700">
              We sent a verification link to{' '}
              <span className="font-medium">{pendingEmailCopy || 'your email'}</span>. Approve it to
              finish signing in.
            </p>
            {statusCopy ? (
              <p className="text-xs text-slate-500">
                Status: <span className="font-medium">{statusCopy}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleResend()}
                className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
              >
                Resend email
              </button>
              {verification.manualRetryAvailable ? (
                <button
                  type="button"
                  onClick={() => void verification.retryCompletionNow()}
                  disabled={verification.completing}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {verification.completing ? 'Finishing…' : 'Finish setup'}
                </button>
              ) : null}
              {needsEmailInput ? (
                <button
                  type="button"
                  onClick={() => {
                    verification.reset();
                    setInfo(null);
                    setError(null);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Use a different email
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={backToLogin}
              >
                Back to login
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
