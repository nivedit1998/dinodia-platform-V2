// Architecture: App Router surface src/app/companylogin/first-login/CompanyFirstLoginClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { AuthShell } from '@/components/ui/AuthShell';
import { parseApiError } from '@/lib/authClientError';
import { getCompanyLandingPath, type CompanyPortalRole } from '@/lib/companyPortalAccess';

type ContinueResponse =
  | { ok: true; role: string; redirectTo?: string }
  | { ok?: false; error?: string };

export default function CompanyFirstLoginClient() {
  const router = useRouter();
  const params = useSearchParams();
  const loginIntentId = params.get('loginIntentId') ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!loginIntentId) {
      setError('Missing login session. Please sign in again.');
      return;
    }
    if (!newPassword || !confirmNewPassword) {
      setError('Please enter a new password.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('Passwords must match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/auth/login-intents/${encodeURIComponent(loginIntentId)}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword, confirmNewPassword }),
      });
      const data: ContinueResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));

      if (!res.ok || !data.ok) {
        const parsed = parseApiError(data, 'We could not finish setup. Please try again.');
        setError(parsed.message);
        return;
      }

      router.replace((data.redirectTo || getCompanyLandingPath(data.role as CompanyPortalRole)) as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not finish setup. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Set your password"
      subtitle="Change your temporary password before you continue into the company portal."
      footer="CXO can reset your password again if needed."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          You received a temporary password by email. Choose a new password now.
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">New password</label>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoComplete="new-password"
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Confirm new password</label>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            required
            autoComplete="new-password"
            minLength={8}
          />
        </div>

        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {loading ? 'Updating…' : 'Continue'}
        </button>
      </form>
    </AuthShell>
  );
}
