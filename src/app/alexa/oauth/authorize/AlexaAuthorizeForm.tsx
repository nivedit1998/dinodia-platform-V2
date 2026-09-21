// Architecture: App Router surface src/app/alexa/oauth/authorize/AlexaAuthorizeForm.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  logVerificationCompletionStatusBreadcrumb,
} from '@/lib/authVerificationBreadcrumbs';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { fetchAuthSessionState } from '@/lib/authVerificationRecovery';
import { friendlyUnknownError } from '@/lib/clientError';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

type OAuthParams = {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  state: string | null;
  scope: string | null;
};

const ALEXA_AUTHORIZE_VERIFICATION_KEY = 'alexa_authorize_verification_state';

export function AlexaAuthorizeForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauth, setOauth] = useState<OAuthParams | null>(null);

  const deviceIdRef = useRef<string | null>(null);
  const deviceLabelRef = useRef<string | null>(null);
  const lastPayloadRef = useRef<Record<string, unknown> | null>(null);
  const retriedRef = useRef(false);
  const verificationRef = useRef<{ reset: (options?: { keepError?: boolean }) => void } | null>(null);

  useEffect(() => {
    let canceled = false;
    const apply = (fn: () => void) => {
      queueMicrotask(() => {
        if (!canceled) fn();
      });
    };

    try {
      const params = new URLSearchParams(window.location.search);
      const clientId = params.get('client_id');
      const redirectUri = params.get('redirect_uri');
      const responseType = params.get('response_type') || 'code';
      const state = params.get('state');
      const scope = params.get('scope');

      if (!clientId || !redirectUri) {
        apply(() =>
          setError(
            'The Alexa link is missing some information. Please start linking again from the Alexa app.'
          )
        );
      }

      apply(() => setOauth({ clientId, redirectUri, responseType, state, scope }));
    } catch (err) {
      console.error('Failed to parse OAuth parameters', err);
      apply(() =>
        setError('We couldn’t read that Alexa link. Please start linking again from the Alexa app.')
      );
    }

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    deviceIdRef.current = getOrCreateDeviceId();
    deviceLabelRef.current = getDeviceLabel();
  }, []);

  const resetVerification = useCallback((options?: { keepError?: boolean }) => {
    verificationRef.current?.reset({ keepError: options?.keepError });
    setInfo(null);
    setLoading(false);
    retriedRef.current = false;
    if (!options?.keepError) {
      setError(null);
    }
  }, []);

  const retryAuthorizeAfterVerification = useCallback(async () => {
    const payload = lastPayloadRef.current;
    if (!payload) {
      setError('We couldn’t finish linking after verification. Please start again from the Alexa app.');
      resetVerification({ keepError: true });
      return;
    }

    if (retriedRef.current) return;
    retriedRef.current = true;

    try {
      const data = await platformFetchJson<{
        redirectTo?: string;
        requiresEmailVerification?: boolean;
        challengeId?: string;
      }>(
        '/api/alexa/oauth/authorize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        'We couldn’t finish linking after verification. Please try again from the Alexa app.'
      );

      if (data.redirectTo) {
        window.location.href = data.redirectTo as string;
        return;
      }

      const fallbackError =
        data.requiresEmailVerification && data.challengeId
          ? 'We couldn’t finish verification. Please start linking again from Alexa.'
          : 'We couldn’t finish linking after verification. Please try again from the Alexa app.';
      setError(fallbackError);
      resetVerification({ keepError: true });
    } catch (err) {
      console.error('Alexa authorize retry failed', err);
      setError(
        friendlyUnknownError(
          err,
          'We couldn’t finish linking after verification. Please try again from the Alexa app.'
        )
      );
      resetVerification({ keepError: true });
    }
  }, [resetVerification]);

  const verification = useEmailVerificationChallenge<Record<string, unknown>>({
    storageKey: ALEXA_AUTHORIZE_VERIFICATION_KEY,
    onApproved: async (id) => {
      const deviceId = deviceIdRef.current ?? getOrCreateDeviceId();
      const deviceLabel = deviceLabelRef.current ?? getDeviceLabel();

      if (!deviceId) {
        throw new Error('Missing device identifier. Please try again.');
      }

      const data = await platformFetchJson<{ ok: boolean; completionStatus?: string }>(
        `/api/auth/challenges/${id}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, deviceLabel }),
        },
        'Unable to finish verification. Please try again.'
      );
      logVerificationCompletionStatusBreadcrumb({
        challengeId: id,
        source: 'alexa_authorize',
        completionStatus: data.completionStatus,
      });

      await retryAuthorizeAfterVerification();
    },
    onConsumed: async () => {
      try {
        const session = await fetchAuthSessionState();
        if (!session.authenticated) return false;
        await retryAuthorizeAfterVerification();
        return true;
      } catch {
        return false;
      }
    },
    onTerminalStatus: (terminalStatus) => {
      setError(
        terminalStatus === 'EXPIRED'
          ? 'Link expired, please try again from Alexa.'
          : 'Verification link is no longer valid. Please start again from Alexa.'
      );
    },
  });
  useEffect(() => {
    verificationRef.current = verification;
  }, [verification]);
  const restoreVerification = verification.restore;

  useEffect(() => {
    void restoreVerification();
  }, [restoreVerification]);

  const startChallengePolling = useCallback(
    async (id: string, payload: Record<string, unknown>) => {
      await verification.start(id, payload);
    },
    [verification]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    retriedRef.current = false;
    verification.reset();

    if (!oauth || !oauth.clientId || !oauth.redirectUri || !oauth.responseType) {
      setError('Some link details are missing. Please start linking again from the Alexa app.');
      return;
    }

    const deviceId = deviceIdRef.current ?? getOrCreateDeviceId();
    const deviceLabel = deviceLabelRef.current ?? getDeviceLabel();
    deviceIdRef.current = deviceId;
    deviceLabelRef.current = deviceLabel;

    if (!deviceId) {
      setError('Missing device identifier. Please try again.');
      return;
    }

    const payload: Record<string, unknown> = {
      username,
      password,
      clientId: oauth.clientId,
      redirectUri: oauth.redirectUri,
      responseType: oauth.responseType,
      state: oauth.state ?? undefined,
      scope: oauth.scope ?? undefined,
      deviceId,
      deviceLabel,
    };
    lastPayloadRef.current = payload;

    setLoading(true);

    try {
      const data = await platformFetchJson<{
        redirectTo?: string;
        requiresEmailVerification?: boolean;
        challengeId?: string;
      }>(
        '/api/alexa/oauth/authorize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        'We couldn’t finish linking with Alexa. Please try again in a moment.'
      );

      if (data.requiresEmailVerification) {
        if (!data.challengeId) {
          setError('We could not start verification. Please try again.');
          setLoading(false);
          return;
        }
        setInfo('Check your email to approve this login.');
        setLoading(false);
        await startChallengePolling(data.challengeId as string, payload);
        return;
      }

      if (!data.redirectTo) {
        setError('We couldn’t finish the last step of linking. Please start again from the Alexa app.');
        setLoading(false);
        return;
      }

      window.location.href = data.redirectTo as string;
    } catch (err) {
      console.error('Alexa authorize failed', err);
      setError(friendlyUnknownError(err, 'We couldn’t reach Alexa right now. Please try again.'));
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!verification.challengeId) return;
    setError(null);
    setInfo(null);

    try {
      await verification.resend();
    } catch (err) {
      console.error('Alexa verification resend failed', err);
      setError(friendlyUnknownError(err, 'Unable to resend the verification email right now.'));
    }
  }

  return (
    <div className="space-y-4">
      {(error || verification.error) && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error || verification.error}
        </div>
      )}
      {(info || verification.info) && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          {info || verification.info}
        </div>
      )}

      {!verification.waiting && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Dinodia Username</label>
            <input
              className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {loading ? 'Linking…' : 'Link Dinodia to Alexa'}
          </button>
        </form>
      )}

      {verification.waiting && (
        <div className="space-y-3 text-sm">
          <p className="text-slate-700">
            Check your email and approve this login. We’ll finish linking to Alexa as soon as you
            approve the device.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
            <div className="text-sm font-medium text-slate-800">
              {verification.status ?? 'Waiting for approval…'}
            </div>
            {verification.completing && (
              <div className="text-xs text-slate-500 mt-1">Finishing up…</div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleResend}
              className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
            >
              Resend email
            </button>
            {verification.manualRetryAvailable ? (
              <button
                onClick={() => void verification.retryCompletionNow()}
                className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
              >
                Finish linking
              </button>
            ) : null}
            <button
              onClick={() => resetVerification()}
              className="flex-1 rounded-lg border border-slate-200 bg-white py-2 font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to login
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
