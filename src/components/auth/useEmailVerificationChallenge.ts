// Architecture: Reusable web UI component src/components/auth/useEmailVerificationChallenge.ts; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientApiError,
  parseClientApiError,
} from '@/lib/clientError';
import { logVerificationConsumedAfterApprovalBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { platformFetch, platformFetchJson } from '@/lib/platformFetchClient';

export type EmailChallengeStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'CONSUMED'
  | 'EXPIRED'
  | 'NOT_FOUND';

type ChallengeStatusResponse = {
  ok?: boolean;
  status?: EmailChallengeStatus;
  expiresAt?: string | null;
  approvedAt?: string | null;
  consumedAt?: string | null;
  serverNow?: string;
  errorCode?: string;
  error?: string;
};

type ChallengeCompletionErrorPayload = {
  reason?: unknown;
};

type ResendResponse = {
  ok?: boolean;
  resentAt?: string;
  resendAvailableAt?: string;
  expiresAt?: string;
  retryAfterSeconds?: number;
  errorCode?: string;
  error?: string;
};

type StoredChallengeState<TState> = {
  challengeId: string | null;
  state: TState | null;
};

type ResetOptions<TState> = {
  preserveState?: boolean;
  nextState?: TState | null;
  keepInfo?: boolean;
  keepError?: boolean;
};

export type UseEmailVerificationChallengeOptions<TState> = {
  storageKey?: string;
  onApproved: (challengeId: string, state: TState | null) => Promise<void>;
  onConsumed?: (challengeId: string, state: TState | null) => Promise<boolean>;
  onTerminalStatus?: (
    status: Exclude<EmailChallengeStatus, 'PENDING' | 'APPROVED'>,
    state: TState | null
  ) => void;
};

const POLL_INTERVAL_MS = 2000;

export function useEmailVerificationChallenge<TState = Record<string, never>>(
  options: UseEmailVerificationChallengeOptions<TState>
) {
  const { storageKey, onApproved, onConsumed, onTerminalStatus } = options;

  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [status, setStatus] = useState<EmailChallengeStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [manualRetryAvailable, setManualRetryAvailable] = useState(false);
  const [currentState, setCurrentState] = useState<TState | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const challengeIdRef = useRef<string | null>(null);
  const stateRef = useRef<TState | null>(null);
  const completingRef = useRef(false);
  const onApprovedRef = useRef(onApproved);
  const onConsumedRef = useRef(onConsumed);
  const onTerminalStatusRef = useRef(onTerminalStatus);

  useEffect(() => {
    onApprovedRef.current = onApproved;
  }, [onApproved]);

  useEffect(() => {
    onConsumedRef.current = onConsumed;
  }, [onConsumed]);

  useEffect(() => {
    onTerminalStatusRef.current = onTerminalStatus;
  }, [onTerminalStatus]);

  const persistState = useCallback(
    (nextChallengeId: string | null, nextState: TState | null) => {
      stateRef.current = nextState;
      setCurrentState(nextState);
      if (!storageKey) return;
      try {
        if (!nextChallengeId && nextState == null) {
          sessionStorage.removeItem(storageKey);
          return;
        }
        const payload: StoredChallengeState<TState> = {
          challengeId: nextChallengeId,
          state: nextState,
        };
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // best effort
      }
    },
    [storageKey]
  );

  const readStoredState = useCallback((): StoredChallengeState<TState> | null => {
    if (!storageKey) return null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredChallengeState<TState>;
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        challengeId:
          typeof parsed.challengeId === 'string' && parsed.challengeId.trim()
            ? parsed.challengeId
            : null,
        state: parsed.state ?? null,
      };
    } catch {
      return null;
    }
  }, [storageKey]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reset = useCallback(
    (opts?: ResetOptions<TState>) => {
      const nextState =
        opts?.nextState !== undefined
          ? opts.nextState
          : opts?.preserveState
            ? stateRef.current
            : null;
      setChallengeId(null);
      setStatus(null);
      setWaiting(false);
      setCompleting(false);
      setManualRetryAvailable(false);
      if (!opts?.keepError) setError(null);
      if (!opts?.keepInfo) setInfo(null);
      challengeIdRef.current = null;
      completingRef.current = false;
      stopPolling();
      persistState(null, nextState);
    },
    [persistState, stopPolling]
  );

  const classifyRetryableCompletionError = useCallback((err: unknown) => {
    if (err instanceof ClientApiError) {
      return err.status >= 500;
    }
    return true;
  }, []);

  const getCompletionFailureReason = useCallback((err: unknown) => {
    if (!(err instanceof ClientApiError) || !err.payload || typeof err.payload !== 'object') {
      return null;
    }
    const payload = err.payload as ChallengeCompletionErrorPayload;
    return typeof payload.reason === 'string' ? payload.reason : null;
  }, []);

  const tryCompleteRef = useRef<((id: string, currentState: TState | null, attempt: number) => Promise<void>) | null>(null);

  const tryComplete = useCallback(
    async (id: string, currentState: TState | null, attempt: number) => {
      if (completingRef.current) return;
      completingRef.current = true;
      setCompleting(true);
      setManualRetryAvailable(false);
      try {
        await onApprovedRef.current(id, currentState);
        reset();
      } catch (err) {
        const failureReason = getCompletionFailureReason(err);
        if (failureReason === 'ALREADY_CONSUMED') {
          logVerificationConsumedAfterApprovalBreadcrumb({
            challengeId: id,
            source: storageKey ?? 'email_verification',
            reason: failureReason,
          });
          completingRef.current = false;
          setCompleting(false);
          if (onConsumedRef.current && (await onConsumedRef.current(id, currentState))) {
            reset({ preserveState: true });
            return;
          }
          onTerminalStatusRef.current?.('CONSUMED', currentState);
          reset({ preserveState: true });
          return;
        }
        if (attempt === 0 && classifyRetryableCompletionError(err)) {
          completingRef.current = false;
          setCompleting(false);
          await tryCompleteRef.current?.(id, currentState, 1);
          return;
        }
        completingRef.current = false;
        setCompleting(false);
        if (!classifyRetryableCompletionError(err)) {
          const message =
            err instanceof ClientApiError
              ? err.message
              : 'We could not complete verification. Please try again.';
          setError(message);
          reset({ keepError: true });
          return;
        }
        setInfo('Approved. We’ll keep trying, or you can finish manually.');
        setManualRetryAvailable(true);
        setWaiting(true);
      }
    },
    [classifyRetryableCompletionError, getCompletionFailureReason, reset, storageKey]
  );

  useEffect(() => {
    tryCompleteRef.current = tryComplete;
  }, [tryComplete]);

  const fetchStatusOnce = useCallback(
    async (id: string, currentState: TState | null) => {
      const response = await platformFetch(`/api/auth/challenges/${id}`, {
        cache: 'no-store',
      });
      const contentType = response.headers.get('content-type') || '';
      const payload =
        contentType.includes('application/json')
          ? ((await response.json().catch(() => null)) as ChallengeStatusResponse | null)
          : null;

      if (!response.ok) {
        if (payload?.status === 'NOT_FOUND') {
          setStatus('NOT_FOUND');
          onTerminalStatusRef.current?.('NOT_FOUND', currentState);
          reset({ preserveState: true });
          return;
        }
        throw new ClientApiError(
          parseClientApiError(payload, 'Unable to check verification status.', response.status)
            .message,
          response.status,
          payload?.errorCode,
          payload
        );
      }

      const nextStatus = payload?.status ?? null;
      if (!nextStatus) return;

      setStatus(nextStatus);
      setError(null);

      if (nextStatus === 'APPROVED') {
        stopPolling();
        await tryComplete(id, currentState, 0);
        return;
      }

      if (nextStatus === 'CONSUMED') {
        stopPolling();
        if (onConsumedRef.current && (await onConsumedRef.current(id, currentState))) {
          reset({ preserveState: true });
          return;
        }
        onTerminalStatusRef.current?.('CONSUMED', currentState);
        reset({ preserveState: true });
        return;
      }

      if (nextStatus === 'EXPIRED' || nextStatus === 'NOT_FOUND') {
        stopPolling();
        onTerminalStatusRef.current?.(nextStatus, currentState);
        reset({ preserveState: true });
        return;
      }

      setWaiting(true);
      persistState(id, currentState);
    },
    [persistState, reset, stopPolling, tryComplete]
  );

  const refreshNow = useCallback(async () => {
    const id = challengeIdRef.current;
    if (!id) return;
    try {
      await fetchStatusOnce(id, stateRef.current);
    } catch {
      setInfo('Still waiting for approval. We’ll retry when this page is active.');
    }
  }, [fetchStatusOnce]);

  const start = useCallback(
    async (id: string, currentState?: TState | null) => {
      const nextState = currentState ?? stateRef.current ?? null;
      challengeIdRef.current = id;
      setChallengeId(id);
      setStatus('PENDING');
      setWaiting(true);
      setError(null);
      setManualRetryAvailable(false);
      persistState(id, nextState);
      stopPolling();
      await refreshNow();
      if (!challengeIdRef.current) return;
      pollRef.current = setInterval(() => {
        if (document.hidden) return;
        void refreshNow();
      }, POLL_INTERVAL_MS);
    },
    [persistState, refreshNow, stopPolling]
  );

  const restore = useCallback(async () => {
    const stored = readStoredState();
    if (!stored) return null;
    stateRef.current = stored.state ?? null;
    setCurrentState(stored.state ?? null);
    if (stored.challengeId) {
      await start(stored.challengeId, stored.state ?? null);
    }
    return stored.state ?? null;
  }, [readStoredState, start]);

  const retryCompletionNow = useCallback(async () => {
    const id = challengeIdRef.current;
    if (!id) return;
    await tryComplete(id, stateRef.current, 0);
  }, [tryComplete]);

  const resend = useCallback(async () => {
    const id = challengeIdRef.current;
    if (!id) return;
    setError(null);
    setInfo(null);
    try {
      const data = await platformFetchJson<ResendResponse>(
        `/api/auth/challenges/${id}/resend`,
        { method: 'POST' },
        'Unable to resend the verification email right now.'
      );
      const nextInfo = data.retryAfterSeconds
        ? `Verification email sent. You can resend again in about ${data.retryAfterSeconds} seconds.`
        : 'A fresh verification email is on the way.';
      setInfo(nextInfo);
    } catch (err) {
      setError(
        err instanceof ClientApiError
          ? err.message
          : 'Unable to resend the verification email right now.'
      );
    }
  }, []);

  useEffect(() => {
    const handleVisible = () => {
      if (!document.hidden) {
        void refreshNow();
      }
    };

    window.addEventListener('focus', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      window.removeEventListener('focus', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
      stopPolling();
    };
  }, [refreshNow, stopPolling]);

  return {
    challengeId,
    status,
    waiting,
    completing,
    error,
    info,
    manualRetryAvailable,
    start,
    restore,
    refreshNow,
    retryCompletionNow,
    reset,
    resend,
    currentState,
  };
}
