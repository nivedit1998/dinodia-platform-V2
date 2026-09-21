// Architecture: App Router surface src/app/installer/CEPLUS_PATCH_MANAGEMENT/PatchManagementClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function PatchManagementClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">CE+ patch management policy</h1>
          <p className="mt-2 text-sm text-slate-600">
            CE+ requires evidence that security patches are applied promptly across endpoints and servers. This page is
            the policy and evidence checklist; attach screenshots/reports for your actual patching tools.
          </p>
        </div>

        <Section title="1) Policy (minimum baseline)">
          <BulletList
            items={[
              'Staff endpoints: enable automatic OS updates; apply critical patches within 14 days (or faster for active exploitation).',
              'Cloud services: monitor provider advisories and apply configuration fixes promptly.',
              'Dependencies: review and update npm packages regularly; remediate high/critical CVEs quickly.',
              'Document exceptions with justification and target fix date.',
            ]}
          />
        </Section>

        <Section title="2) Evidence to show (examples)">
          <BulletList
            items={[
              'OS patch compliance report (MDM, Windows Update, macOS update status, etc.).',
              'Screenshots of auto-update settings on admin endpoints (or policy screenshots from MDM).',
              'Dependency update cadence (PR history, changelog, or release notes).',
              'Vulnerability scan results + remediation tracking (tickets).',
            ]}
          />
        </Section>

        <Section title="3) What to verify in this repo (code-adjacent evidence)">
          <BulletList
            items={[
              'Keep Next.js and major dependencies reasonably current.',
              'Run lint/build in CI on main branch.',
              'Keep parity between Vercel and AWS backends so security fixes apply to both.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
