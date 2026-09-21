// Architecture: App Router surface src/app/installer/CEPLUS_ACCESS_CONTROL/AccessControlClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function AccessControlClient({ installerName }: { installerName: string }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">Installer</p>
            <p className="text-lg font-semibold text-slate-900">{installerName}</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/installer/GDPR_Status"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Back to GDPR Status
            </Link>
            <Link
              href="/installer/CYBER_ESSENTIALS_PLUS"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              CE+ Overview
            </Link>
            <Link
              href="/companylogin/login"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Sign out
            </Link>
          </div>
        </header>

        <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
          <h1 className="text-2xl font-semibold text-slate-900">CE+ access control and MFA evidence</h1>
          <p className="mt-2 text-sm text-slate-600">
            CE+ requires strong access controls for admin consoles and systems. This page lists what to enforce and
            what evidence to capture. Cover both Vercel and AWS hosting modes.
          </p>
        </div>

        <Section title="1) MFA enforcement (must be on for all privileged accounts)">
          <BulletList
            items={[
              'Cloudflare: enforce MFA for all members, restrict “Super Administrator” to minimum.',
              'Vercel: enforce MFA/SSO for team members with production access.',
              'AWS: enforce MFA for IAM users (prefer SSO); remove unused access keys.',
              'Supabase: enforce MFA for project owners/admins; restrict SQL editor/backups access.',
              'Code hosting (GitHub/GitLab): enforce MFA; restrict org owner role.',
              'Email provider: enforce MFA; restrict template/sending domain admin access.',
            ]}
          />
        </Section>

        <Section title="2) Least privilege and role-based access">
          <BulletList
            items={[
              'Remove “owner/admin” where “developer/viewer” is sufficient.',
              'Separate duties: deployment vs DB admin vs security/on-call.',
              'Maintain a small list of break-glass accounts and rotate credentials regularly.',
              'Restrict access to logs and backups; treat both as sensitive data surfaces.',
            ]}
          />
        </Section>

        <Section title="3) Access reviews (required evidence)">
          <BulletList
            items={[
              'Perform quarterly access review for each provider (Cloudflare/Vercel/AWS/Supabase/code hosting/email).',
              'Record who reviewed, date, and what was removed/changed.',
              'Immediately remove access when staff leave or role changes.',
            ]}
          />
        </Section>

        <Section title="4) Application-level access controls (what we rely on)">
          <BulletList
            items={[
              'App roles: ADMIN / INSTALLER / TENANT are enforced server-side.',
              'Installer pages are installer-only; admin/tenant cannot access them.',
              'Support access is designed to be explicit, time-limited, revocable, and auditable.',
            ]}
          />
        </Section>

        <Section title="5) Evidence to show (examples)">
          <BulletList
            items={[
              'Screenshots: MFA enforcement enabled in each provider.',
              'Screenshots: membership list showing least privilege roles.',
              'Access review record (document/ticket) with date and reviewer.',
              'Break-glass procedure and audit trail evidence (see Security Checklist + ICO pages).',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
