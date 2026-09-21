// Architecture: App Router surface src/app/forgot-password/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { friendlyErrorFromUnknown, parseApiError } from '@/lib/authClientError';
import { AuthShell } from '@/components/ui/AuthShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';

type PasswordResetRole = 'TENANT' | 'ADMIN';

function normalizeRole(value: string | null): PasswordResetRole | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'TENANT' || normalized === 'ADMIN') return normalized;
  return null;
}

function roleLabel(role: PasswordResetRole): string {
  return role === 'TENANT' ? 'tenant' : 'homeowner';
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const roleFromUrl = useMemo(() => normalizeRole(searchParams.get('role')), [searchParams]);
  const [selectedRole, setSelectedRole] = useState<PasswordResetRole | null>(roleFromUrl);
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!selectedRole) {
      setError('Choose whether you are resetting a tenant or homeowner password.');
      return;
    }

    if (!identifier.trim()) {
      setError('Please enter your username or email.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, role: selectedRole }),
      });

      const data = await res.json().catch(() => ({}));
      setLoading(false);

      if (!res.ok) {
        const parsed = parseApiError(
          data,
          'Unsuccessful - please try again in a moment.'
        );
        setError(parsed.message);
        return;
      }

      setInfo(
        `If we found a matching ${roleLabel(selectedRole)} account, a reset link is on the way.`
      );
    } catch (err) {
      console.error(err);
      setLoading(false);
      setError(friendlyErrorFromUnknown(err, 'Unsuccessful - please try again in a moment.'));
    }
  }

  const pageTitle = selectedRole
    ? `Reset your ${roleLabel(selectedRole)} password`
    : 'Reset your password';
  const pageSubtitle = selectedRole
    ? `Enter the username or email for your Dinodia ${roleLabel(selectedRole)} account.`
    : 'Choose which account type you want to reset, then enter your username or email.';

  return (
    <AuthShell
      title={pageTitle}
      subtitle={pageSubtitle}
      footer={
        <button
          className="font-semibold text-[var(--indigo)] hover:underline"
          onClick={() => router.push('/login')}
        >
          Back to sign in
        </button>
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
        {!roleFromUrl ? (
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant={selectedRole === 'TENANT' ? 'primary' : 'secondary'}
              onClick={() => setSelectedRole('TENANT')}
              fullWidth
            >
              Tenant
            </Button>
            <Button
              type="button"
              variant={selectedRole === 'ADMIN' ? 'primary' : 'secondary'}
              onClick={() => setSelectedRole('ADMIN')}
              fullWidth
            >
              Homeowner
            </Button>
          </div>
        ) : null}
        <Field
          label="Username or email"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          required
        />
        <Button type="submit" loading={loading} fullWidth>
          {loading ? 'Sending secure link' : 'Send reset link'}
        </Button>
      </form>
    </AuthShell>
  );
}
