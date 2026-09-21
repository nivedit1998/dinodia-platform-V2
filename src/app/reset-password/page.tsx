// Architecture: App Router surface src/app/reset-password/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell } from '@/components/ui/AuthShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Prevent referrer headers from leaking the token.
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!token) {
      setError('This reset link is unavailable. Please request a new one.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/password-reset/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword, confirmPassword }),
      });

      const data = await res.json().catch(() => ({}));
      setLoading(false);

      if (!res.ok) {
        setError(
          data?.error ||
            'Unsuccessful - please try again in a moment.'
        );
        return;
      }

      setInfo('Password updated. You can now sign in with your new password.');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      console.error(err);
      setLoading(false);
      setError('Unsuccessful - please try again in a moment.');
    }
  }

  if (!token) {
    return (
      <AuthShell
        title="Reset link unavailable"
        subtitle="Please request a new link to continue."
        footer={
          <button
            className="font-semibold text-[var(--indigo)] hover:underline"
            onClick={() => router.push('/forgot-password')}
          >
            Request a new reset link
          </button>
        }
      >
        <Card className="rounded-[14px] border-[color:var(--warning)] bg-[color:var(--warning)]/12 p-3 text-sm text-foreground">
          This link has expired or is no longer available.
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Enter and confirm your new password."
      footer={
        <>
          <button
            className="font-semibold text-[var(--indigo)] hover:underline"
            onClick={() => router.push('/login')}
          >
            Back to sign in
          </button>
          <span className="mx-2 text-muted">|</span>
          <button
            className="font-semibold text-[var(--indigo)] hover:underline"
            onClick={() => router.push('/forgot-password')}
          >
            Request a new link
          </button>
        </>
      }
    >
      {error ? (
        <Card className="mb-4 rounded-[14px] border-[color:var(--danger)] bg-[color:var(--danger)]/12 p-3 text-sm text-foreground">
          {error}
        </Card>
      ) : null}
      {info ? (
        <Card className="mb-4 rounded-[14px] border-[color:var(--success)] bg-[color:var(--success)]/12 p-3 text-sm text-foreground">
          {info}
        </Card>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="New password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
        />
        <Button type="submit" loading={loading} fullWidth>
          {loading ? 'Updating password' : 'Update password'}
        </Button>
      </form>
    </AuthShell>
  );
}
