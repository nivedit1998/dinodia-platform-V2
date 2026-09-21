// Architecture: Reusable web UI component src/components/companyPortal/CompanyPortalShell.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Role } from '@prisma/client';
import { logout } from '@/lib/logout';
import {
  COMPANY_PORTAL_ROLE_LABELS,
  getCompanyPortalTabs,
  getCompanyRoleLabel,
  type CompanyPortalRole,
} from '@/lib/companyPortalAccess';

type Props = {
  username: string;
  role: Role | null | undefined;
  children: ReactNode;
};

export function CompanyPortalShell({ username, role, children }: Props) {
  const pathname = usePathname();
  const tabs = getCompanyPortalTabs(role);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Dinodia Smart Living</p>
              <h1 className="text-2xl font-semibold text-slate-900">Company Portal</h1>
              <p className="mt-1 text-sm text-slate-600">
                Internal access for {getCompanyRoleLabel(role)} users.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-right">
              <p className="text-xs uppercase tracking-wide text-slate-500">Signed in as</p>
              <p className="text-base font-semibold text-slate-900">{username}</p>
              <p className="text-sm text-slate-600">{COMPANY_PORTAL_ROLE_LABELS[role as CompanyPortalRole]}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {tabs.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={[
                    'rounded-full px-4 py-2 text-sm font-semibold transition',
                    active
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
                  ].join(' ')}
                >
                  {tab.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => void logout({ fallbackUrl: '/companylogin/login' })}
              className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
