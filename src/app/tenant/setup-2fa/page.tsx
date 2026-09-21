// Architecture: App Router surface src/app/tenant/setup-2fa/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { friendlyErrorFromUnknown, parseApiError } from '@/lib/authClientError';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

type PendingLoginState = {
  loginIntentId: string;
  deviceId?: string;
  deviceLabel?: string;
  challengeId?: string | null;
};

type PendingVerificationState = PendingLoginState & {
  email: string;
};

const TENANT_SETUP_KEY = 'tenant_setup_state';
const TENANT_SETUP_VERIFICATION_KEY = 'tenant_setup_verification_state';

export default function TenantSetup2FA() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingLoginState | null>(null);

  const clearSavedState = useCallback(() => {
    try {
      sessionStorage.removeItem(TENANT_SETUP_KEY);
    } catch {
      // ignore
    }
  }, []);

  const loadPending = useCallback((): PendingLoginState | null => {
    try {
      const raw = sessionStorage.getItem(TENANT_SETUP_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PendingLoginState;
      if (parsed && parsed.loginIntentId) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const savePending = useCallback((value: PendingLoginState) => {
    try {
      sessionStorage.setItem(TENANT_SETUP_KEY, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, []);

  const verification = useEmailVerificationChallenge<PendingVerificationState>({
    storageKey: TENANT_SETUP_VERIFICATION_KEY,
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
        source: 'tenant_setup_2fa',
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
          ? 'The verification link expired. Please send a new one.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Please start again from this screen.'
            : 'Verification request not found. Please send a new email.'
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
      const saved = loadPending();
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
      setPending(withDevice);
      savePending(withDevice);

      const restored = await restoreVerification();
      if (cancelled || !restored) return;
      setPending(restored);
      setEmail(restored.email || '');
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [loadPending, restoreVerification, savePending]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setInfo(null);

      const saved = pending ?? loadPending();
      if (!saved) {
        setError('Login session missing. Please start from the login page.');
        return;
      }

      const trimmedEmail = email.trim();
      if (!trimmedEmail) {
        setError('Please enter your email.');
        return;
      }

      const nextState: PendingVerificationState = {
        ...saved,
        deviceId: saved.deviceId || getOrCreateDeviceId(),
        deviceLabel: saved.deviceLabel || getDeviceLabel(),
        email: trimmedEmail,
      };

      setPending(nextState);
      savePending(nextState);
      setLoading(true);

      try {
        const res = await fetch(`/api/auth/login-intents/${saved.loginIntentId}/continue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            email: trimmedEmail,
            deviceLabel: nextState.deviceLabel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(parseApiError(data, 'We could not start verification. Please try again.').message);
        }

        if (data.requiresEmailVerification && data.challengeId) {
          setInfo('Check your email to approve this device.');
          await verification.start(data.challengeId, nextState);
          return;
        }

        if (data.ok) {
          verification.reset();
          clearSavedState();
          router.push('/tenant/dashboard');
          return;
        }

        throw new Error('We could not start verification. Please try again.');
      } catch (err) {
        setError(friendlyErrorFromUnknown(err, 'We could not start verification.'));
      } finally {
        setLoading(false);
      }
    },
    [clearSavedState, email, loadPending, pending, router, savePending, verification]
  );

  const handleResend = useCallback(async () => {
    setError(null);
    setInfo(null);
    await verification.resend();
  }, [verification]);

  if (!pending) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8 space-y-4">
          <h1 className="text-xl font-semibold text-center">Set up email verification</h1>
          <p className="text-sm text-slate-600 text-center">
            We couldn’t find your login details. Please return to the login page to start again.
          </p>
          <button
            className="w-full rounded-lg bg-indigo-600 text-white py-2.5 text-sm font-medium hover:bg-indigo-700"
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
      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8">
        <h1 className="text-2xl font-semibold mb-2 text-center">Verify your email</h1>
        <p className="text-sm text-slate-500 mb-6 text-center">
          Add your email to secure new devices. We’ll trust this device after you finish.
        </p>

        {(error || verification.error) && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error || verification.error}
          </div>
        )}
        {(info || verification.info) && (
          <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
            {info || verification.info}
          </div>
        )}

        {!awaitingVerification ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
              <p className="mt-1 text-xs text-slate-500">
                Use the email your homeowner used when creating your tenant account.
              </p>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
            >
              {loading ? 'Sending…' : 'Send verification email'}
            </button>
            <button
              type="button"
              className="w-full text-sm text-slate-600 underline"
              onClick={backToLogin}
            >
              Back to login
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              We sent a verification link to{' '}
              <span className="font-medium">{pendingEmailCopy || 'your email'}</span>. Approve it to finish
              signing in.
            </p>
            {statusCopy ? (
              <p className="text-xs text-slate-500">
                Status: <span className="font-medium">{statusCopy}</span>
              </p>
            ) : null}
            <div className="flex gap-2 flex-wrap">
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
              <button
                type="button"
                onClick={() => {
                  verification.reset();
                  setInfo(null);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Enter a different email
              </button>
            </div>
            <button
              type="button"
              className="text-sm text-slate-600 underline"
              onClick={backToLogin}
            >
              Back to login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
