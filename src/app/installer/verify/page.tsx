// Architecture: App Router surface src/app/installer/verify/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

const INSTALLER_VERIFY_VERIFICATION_KEY = 'installer_verify_verification_state';

export default function InstallerVerifyPage() {
  const params = useSearchParams();
  const router = useRouter();
  const challengeId = params.get('challengeId');

  const [error, setError] = useState<string | null>(null);
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [deviceLabel] = useState(() => getDeviceLabel());
  const verification = useEmailVerificationChallenge({
    storageKey: INSTALLER_VERIFY_VERIFICATION_KEY,
    onApproved: async (id) => {
      if (!deviceId) {
        throw new Error('Device info missing. Please try again.');
      }
      const data = await platformFetchJson<{ role?: string; completionStatus?: string }>(
        `/api/auth/challenges/${id}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, deviceLabel }),
        },
        'Verification failed. Please sign in again.'
      );
      logVerificationCompletionStatusBreadcrumb({
        challengeId: id,
        source: 'installer_verify',
        completionStatus: data.completionStatus,
      });
      if (data.role === 'INSTALLER') {
        router.push('/installer/provision');
        return;
      }
      throw new Error('This account is not an installer.');
    },
    onConsumed: async () => {
      return resumeAuthenticatedSession(router);
    },
    onTerminalStatus: (terminalStatus) => {
      setError(
        terminalStatus === 'EXPIRED'
          ? 'Verification expired. Please sign in again.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Please sign in again.'
            : 'Verification request not found or expired.'
      );
    },
  });
  const restoreVerification = verification.restore;
  const startVerification = verification.start;

  useEffect(() => {
    if (challengeId) {
      void startVerification(challengeId);
      return;
    }
    void restoreVerification();
  }, [challengeId, restoreVerification, startVerification]);

  const activeChallengeId = challengeId || verification.challengeId;

  if (!activeChallengeId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
          <h1 className="text-2xl font-semibold text-slate-900">Check your email</h1>
          <p className="mt-2 text-sm text-slate-600">Missing verification request. Please sign in again.</p>
          <button
            onClick={() => router.push('/companylogin/login')}
            className="mt-4 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">Check your email</h1>
        <p className="mt-2 text-sm text-slate-600">
          We emailed a verification link. After clicking it, this page will continue automatically.
        </p>

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <div>Status: {verification.status ?? 'PENDING'}</div>
          {(error || verification.error) && <div className="mt-1 text-rose-600">{error || verification.error}</div>}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={() => void verification.retryCompletionNow()}
            disabled={verification.completing}
            className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {verification.completing ? 'Finishing…' : 'I clicked the link'}
          </button>
          <button
            onClick={() => router.push('/companylogin/login')}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            Back to login
          </button>
        </div>
      </div>
    </div>
  );
}
