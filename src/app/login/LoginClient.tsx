// Architecture: App Router surface src/app/login/LoginClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { parseApiError } from '@/lib/authClientError';
import { logVerificationCompletionStatusBreadcrumb } from '@/lib/authVerificationBreadcrumbs';
import { resumeAuthenticatedSession } from '@/lib/authVerificationRecovery';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { AuthShell } from '@/components/ui/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Card } from '@/components/ui/Card';
import { useEmailVerificationChallenge } from '@/components/auth/useEmailVerificationChallenge';

type ExpectedRole = 'TENANT' | 'ADMIN';

const TENANT_SETUP_KEY = 'tenant_setup_state';
const TENANT_FIRST_LOGIN_KEY = 'tenant_first_login_state';
const TENANT_LOGIN_VERIFICATION_KEY = 'tenant_login_verification_state';
const HOMEOWNER_LOGIN_VERIFICATION_KEY = 'homeowner_login_verification_state';

export function LoginClient({
  expectedRole,
  initialIdentifier = '',
}: {
  expectedRole: ExpectedRole;
  initialIdentifier?: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState(initialIdentifier);
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsEmailInput, setNeedsEmailInput] = useState(false);
  const [deviceId] = useState(() => (typeof window === 'undefined' ? '' : getOrCreateDeviceId()));
  const [deviceLabel] = useState(() => (typeof window === 'undefined' ? '' : getDeviceLabel()));

  const isTenantEntry = expectedRole === 'TENANT';
  const otherEntryHref = isTenantEntry ? '/login/homeowner' : '/login/tenant';
  const verificationStorageKey = isTenantEntry
    ? TENANT_LOGIN_VERIFICATION_KEY
    : HOMEOWNER_LOGIN_VERIFICATION_KEY;

  const subtitle = useMemo(() => {
    return isTenantEntry ? 'Tenant sign in' : 'Homeowner sign in';
  }, [isTenantEntry]);

  const persistTenantSetupState = useCallback(
    (state: {
      loginIntentId: string;
      deviceId: string;
      deviceLabel: string;
      challengeId?: string | null;
      needsEmailInput?: boolean;
    }) => {
      try {
        sessionStorage.setItem(
          TENANT_SETUP_KEY,
          JSON.stringify({
            ...state,
            challengeId: state.challengeId ?? null,
            needsEmailInput: state.needsEmailInput ?? false,
          })
        );
      } catch {
        // best effort
      }
    },
    []
  );

  const persistTenantFirstLoginState = useCallback(
    (state: { loginIntentId: string; deviceId: string; deviceLabel: string; needsEmailInput?: boolean }) => {
      try {
        sessionStorage.setItem(
          TENANT_FIRST_LOGIN_KEY,
          JSON.stringify({
            ...state,
            needsEmailInput: state.needsEmailInput ?? false,
          })
        );
      } catch {
        // best effort
      }
    },
    []
  );

  const verification = useEmailVerificationChallenge<{ email?: string }>({
    storageKey: verificationStorageKey,
    onApproved: async (id) => {
      if (!deviceId) {
        throw new Error('We could not verify this device right now. Please try again.');
      }

      const data = await platformFetchJson<{
        role?: 'ADMIN' | 'TENANT';
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
        source: 'homeowner_login',
        completionStatus: data.completionStatus,
      });

      if (data.role === 'ADMIN' && data.requiresHomeownerPolicyAcceptance) {
        router.push('/homeowner/policy');
        return;
      }
      if (data.role === 'ADMIN') router.push('/admin/dashboard');
      else router.push('/tenant/dashboard');
    },
    onConsumed: async () => {
      return resumeAuthenticatedSession(router);
    },
    onTerminalStatus: (terminalStatus) => {
      setNeedsEmailInput(false);
      setError(
        terminalStatus === 'EXPIRED'
          ? 'Verification has expired. Please sign in again.'
          : terminalStatus === 'CONSUMED'
            ? 'This verification link was already used. Sign in again to continue.'
            : 'Your previous verification session ended. Sign in again to continue.'
      );
    },
  });

  const awaitingVerification = verification.waiting && !!verification.challengeId;
  const restoreVerification = verification.restore;

  useEffect(() => {
    if (!isTenantEntry) {
      void restoreVerification();
    }
  }, [isTenantEntry, restoreVerification]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorCode(null);
    setInfo(null);

    if (!deviceId) {
      setError('Preparing your secure sign-in details. Please try again in a moment.');
      return;
    }

    if (needsEmailInput) {
      if (!email) {
        setError('Please enter an email address.');
        return;
      }
    }

    setLoading(true);
    const payload: Record<string, unknown> = {
      username,
      password,
      deviceId,
      deviceLabel,
      expectedRole,
    };
    if (needsEmailInput) payload.email = email;

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) {
      const parsed = parseApiError(data, 'We couldn’t log you in. Check your details and try again.');
      setError(parsed.message);
      setErrorCode(parsed.errorCode ?? null);
      return;
    }

    if (data.requiresPasswordChange && data.role === 'TENANT') {
      if (!data.loginIntentId) {
        setError('We could not continue this sign-in session. Please try again.');
        return;
      }
      if (!deviceId || !deviceLabel) {
        setError('We could not verify this device right now. Please try again.');
        return;
      }
      persistTenantFirstLoginState({
        loginIntentId: data.loginIntentId,
        deviceId,
        deviceLabel,
        needsEmailInput: Boolean(data.needsEmailInput),
      });
      router.push('/auth/tenant/first-login');
      return;
    }

    if (data.requiresEmailVerification) {
      const isTenant = data.role === 'TENANT';

      if (isTenant) {
        if (!data.loginIntentId) {
          setError('We could not continue this sign-in session. Please try again.');
          return;
        }
        if (!deviceId || !deviceLabel) {
          setError('We could not verify this device right now. Please try again.');
          return;
        }
        persistTenantSetupState({
          loginIntentId: data.loginIntentId,
          deviceId,
          deviceLabel,
          challengeId: data.challengeId ?? null,
          needsEmailInput: Boolean(data.needsEmailInput),
        });
        router.push('/auth/tenant/setup-2fa');
        return;
      }

      // Admin flow (inline email collection)
      if (data.needsEmailInput) {
        setNeedsEmailInput(true);
        verification.reset();
        setInfo('Add your homeowner email to continue.');
        return;
      }

      if (data.challengeId) {
        setNeedsEmailInput(false);
        setInfo('Check your email to approve this device.');
        await verification.start(data.challengeId, {
          email: needsEmailInput ? email : undefined,
        });
        return;
      }

      setError('We could not start verification. Please try again.');
      return;
    }

    if (data.role === 'ADMIN' && data.requiresHomeownerPolicyAcceptance) {
      router.push('/homeowner/policy');
      return;
    }
    if (data.role === 'ADMIN') router.push('/admin/dashboard');
    else router.push('/tenant/dashboard');
  }

  async function handleResend() {
    if (!verification.challengeId) return;
    setError(null);
    setErrorCode(null);
    setInfo(null);
    await verification.resend();
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle={subtitle}
      footer={
        isTenantEntry ? (
          <>
            Need homeowner access?{' '}
            <button
              className="font-semibold text-[var(--indigo)] hover:underline"
              onClick={() => router.push(otherEntryHref)}
            >
              Go to Homeowner login
            </button>
          </>
        ) : (
          <>
            First time here?{' '}
            <button
              className="font-semibold text-[var(--indigo)] hover:underline"
              onClick={() => router.push('/register-admin')}
            >
              Set up this home
            </button>
            <span className="mx-2 text-muted">|</span>
            Have a claim code?{' '}
            <button
              className="font-semibold text-[var(--indigo)] hover:underline"
              onClick={() => router.push('/claim')}
            >
              Go to claim
            </button>
          </>
        )
      }
    >
      {error || verification.error ? (
        <Card className="mb-4 rounded-[14px] border-[var(--danger)]/35 bg-[var(--danger)]/12 p-3 text-sm text-foreground">
          {error || verification.error}
          {errorCode === 'ROLE_MISMATCH' ? (
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                fullWidth
                onClick={() => router.push(`${otherEntryHref}?identifier=${encodeURIComponent(username)}`)}
              >
                Switch to {isTenantEntry ? 'Homeowner' : 'Tenant'} login
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {info || verification.info ? (
        <Card className="mb-4 rounded-[14px] border-[var(--warning)]/35 bg-[var(--warning)]/12 p-3 text-sm text-foreground">
          {info || verification.info}
        </Card>
      ) : null}

      {!awaitingVerification ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label="Email or username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {needsEmailInput ? (
            <Card surface="muted" className="space-y-3 rounded-[14px] p-3">
              <p className="text-xs text-muted">Please add your email to complete secure sign-in.</p>
              <Field
                label={isTenantEntry ? 'Tenant email' : 'Homeowner email'}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <p className="text-xs text-muted">We’ll send a verification link to this email.</p>
            </Card>
          ) : null}

          <Button type="submit" loading={loading} fullWidth>
            Continue
          </Button>

          <Button
            type="button"
            variant="quiet"
            fullWidth
            onClick={() => router.push(`/forgot-password?role=${expectedRole}`)}
          >
            Forgot password?
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <Card surface="muted" className="rounded-[14px] p-3 text-sm text-foreground">
            {verification.status === 'APPROVED'
              ? 'Approved. Completing sign-in…'
              : verification.status === 'CONSUMED'
                ? 'This verification link was already used.'
                : verification.status === 'EXPIRED'
                  ? 'This verification link has expired.'
                  : 'Waiting for you to approve the email link.'}
          </Card>
          <Button type="button" variant="secondary" fullWidth onClick={() => void handleResend()}>
            Resend email
          </Button>
          {verification.manualRetryAvailable ? (
            <Button
              type="button"
              variant="secondary"
              fullWidth
              onClick={() => void verification.retryCompletionNow()}
            >
              Finish sign-in
            </Button>
          ) : null}
          <Button
            type="button"
            variant="quiet"
            fullWidth
            onClick={() => {
              verification.reset();
              setNeedsEmailInput(false);
            }}
          >
            Back to sign in
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
