// Architecture: Shared platform helper src/lib/logout.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
'use client';

export type LogoutOptions = {
  fallbackUrl?: string;
  restoredInstallerUrl?: string;
};

export async function logout(options: LogoutOptions = {}) {
  const { fallbackUrl = '/login', restoredInstallerUrl = '/installer/HomeSupport' } = options;
  try {
    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    if (data?.restoredInstaller) {
      window.location.href = restoredInstallerUrl;
      return;
    }
  } catch (err) {
    console.error('Failed to logout', err);
  } finally {
    window.location.href = fallbackUrl;
  }
}
