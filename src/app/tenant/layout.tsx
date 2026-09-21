// Architecture: App Router surface src/app/tenant/layout.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';

export default async function TenantLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  return (
    <div className="min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
        <div className="sticky top-4 z-40 flex flex-wrap items-center justify-between gap-3 rounded-full border border-border bg-surface/85 px-4 py-2 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--indigo)]" />
            Tenant Control
          </div>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            <Link
              href="/tenant/dashboard"
              className="rounded-full px-3 py-1.5 font-medium text-foreground hover:bg-surface-2"
            >
              Dashboard
            </Link>
            <Link
              href="/tenant/automations"
              className="rounded-full px-3 py-1.5 font-medium text-foreground hover:bg-surface-2"
            >
              Automations
            </Link>
            <Link
              href="/tenant/settings"
              className="rounded-full px-3 py-1.5 font-medium text-foreground hover:bg-surface-2"
            >
              Settings
            </Link>
          </nav>
        </div>
      </div>
      <main>{children}</main>
    </div>
  );
}
