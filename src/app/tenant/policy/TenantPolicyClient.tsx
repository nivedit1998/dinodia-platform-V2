// Architecture: App Router surface src/app/tenant/policy/TenantPolicyClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { getOrCreateDeviceId } from '@/lib/clientDevice';

type Props = {
  username: string;
  privacyVersion: string;
  termsVersion: string;
};

export default function TenantPolicyClient({ username, privacyVersion, termsVersion }: Props) {
  const router = useRouter();
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);

  useEffect(() => {
    setAcceptPrivacy(false);
    setAcceptTerms(false);
  }, [privacyVersion, termsVersion]);

  async function submit() {
    setError(null);
    if (!acceptPrivacy || !acceptTerms) {
      setError('Please confirm you have read the Privacy Notice and agree to the Terms to continue.');
      return;
    }
    setSubmitting(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (deviceId) headers['x-device-id'] = deviceId;

      const privacyRes = await fetch('/api/policy/accept', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'PRIVACY_NOTICE', version: privacyVersion }),
      });
      const privacyData = await privacyRes.json().catch(() => ({}));
      if (!privacyRes.ok || !privacyData.ok) {
        throw new Error((privacyData && privacyData.error) || 'Unable to record privacy acceptance.');
      }

      const termsRes = await fetch('/api/policy/accept', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'TERMS', version: termsVersion }),
      });
      const termsData = await termsRes.json().catch(() => ({}));
      if (!termsRes.ok || !termsData.ok) {
        throw new Error((termsData && termsData.error) || 'Unable to record terms acceptance.');
      }

      router.replace('/tenant/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to continue.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-10 pb-16 sm:px-6">
      <Card className="rounded-2xl border border-border bg-surface p-6 shadow-lg">
        <h1 className="text-2xl font-semibold text-foreground">Privacy and Terms</h1>
        <p className="mt-2 text-sm text-muted">
          Signed in as <span className="font-semibold text-foreground">{username}</span>
        </p>

        <p className="mt-4 text-sm text-muted">
          To continue using Dinodia, you must review and acknowledge the Privacy Notice and Terms (current versions).
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Link
            href="/privacy"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm font-semibold text-foreground hover:bg-surface-3"
          >
            Open Privacy Notice (v{privacyVersion})
          </Link>
          <Link
            href="/terms"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm font-semibold text-foreground hover:bg-surface-3"
          >
            Open Terms (v{termsVersion})
          </Link>
        </div>

        <div className="mt-5 space-y-3">
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" checked={acceptPrivacy} onChange={(e) => setAcceptPrivacy(e.target.checked)} className="mt-1" />
            <span>I have read the Privacy Notice.</span>
          </label>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} className="mt-1" />
            <span>I agree to the Terms and Conditions.</span>
          </label>
        </div>

        {error ? (
          <p className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          <Button type="button" fullWidth loading={submitting} onClick={submit}>
            Accept and continue
          </Button>
        </div>
      </Card>
    </div>
  );
}
