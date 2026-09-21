// Architecture: App Router surface src/app/companylogin/login/CompanyLoginClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Role } from '@prisma/client';
import { AuthShell } from '@/components/ui/AuthShell';
import { getDeviceLabel, getOrCreateDeviceId } from '@/lib/clientDevice';
import { parseApiError } from '@/lib/authClientError';
import {
  getCompanyLandingPath,
  isCompanyPortalRole,
  type CompanyPortalRole,
} from '@/lib/companyPortalAccess';

type StartResponse =
  | {
      ok: true;
      role: string;
      loginIntentId: string;
      requiresPasswordChange?: boolean;
      passwordPolicy?: { minLength: number };
    }
  | { ok?: false; error?: string };

type ContinueResponse =
  | { ok: true; role: string; redirectTo?: string }
  | { ok?: false; error?: string };

export default function CompanyLoginClient() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const [deviceLabel] = useState(() => getDeviceLabel());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!deviceId) {
      setError('Preparing device info. Please try again in a moment.');
      return;
    }

    setLoading(true);
    try {
      const startRes = await fetch('/api/auth/login-intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId, deviceLabel }),
      });
      const startData: StartResponse = await startRes.json().catch(() => ({ ok: false, error: 'Invalid response' }));

      if (!startRes.ok || !startData.ok) {
        const parsed = parseApiError(startData, 'Login failed. Check your details and try again.');
        setError(parsed.message);
        return;
      }

      if (!isCompanyPortalRole(startData.role as Role)) {
        setError('This account cannot use the company portal.');
        return;
      }

      if (startData.requiresPasswordChange) {
        router.push(
          `/companylogin/first-login?loginIntentId=${encodeURIComponent(startData.loginIntentId)}` as Route
        );
        return;
      }

      const continueRes = await fetch(`/api/auth/login-intents/${encodeURIComponent(startData.loginIntentId)}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const continueData: ContinueResponse = await continueRes.json().catch(() => ({ ok: false, error: 'Invalid response' }));

      if (!continueRes.ok || !continueData.ok) {
        const parsed = parseApiError(continueData, 'We could not finish login. Please try again.');
        setError(parsed.message);
        return;
      }

      router.replace((continueData.redirectTo || getCompanyLandingPath(startData.role as CompanyPortalRole)) as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Company portal login"
      subtitle="Sign in with your company username and temporary or permanent password."
      footer="There is no public registration. CXO creates company users."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="block text-sm font-medium text-slate-700">Username</label>
          <input
            type="text"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">Password</label>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>

        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}
