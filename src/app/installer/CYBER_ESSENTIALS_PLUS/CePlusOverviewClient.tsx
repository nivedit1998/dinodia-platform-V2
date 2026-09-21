// Architecture: App Router surface src/app/installer/CYBER_ESSENTIALS_PLUS/CePlusOverviewClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function CePlusOverviewClient({ installerName }: { installerName: string }) {
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
              href="/installer/provision"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Provision hubs
            </Link>
            <Link
              href="/installer/HomeSupport"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Home Support
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
          <h1 className="text-2xl font-semibold text-slate-900">Cyber Essentials Plus (CE+) — evidence overview</h1>
          <p className="mt-2 text-sm text-slate-600">
            Internal evidence pages to help Dinodia prepare for Cyber Essentials Plus assessment. CE+ is largely
            operational across devices and cloud providers; these pages document what we do and what evidence to show.
          </p>
        </div>

        <Section title="1) Evidence pages">
          <p className="text-sm text-slate-600">Use these pages as printable evidence checklists:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_ASSET_INVENTORY">
              Asset inventory
            </Link>
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_ACCESS_CONTROL">
              Access control / MFA
            </Link>
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_SECURE_CONFIGURATION">
              Secure configuration
            </Link>
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_PATCH_MANAGEMENT">
              Patch management
            </Link>
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_MALWARE_PROTECTION">
              Malware protection
            </Link>
            <Link className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" href="/installer/CEPLUS_FIREWALLS">
              Firewalls / boundary
            </Link>
          </div>
        </Section>

        <Section title="2) Scope and reality check (important)">
          <BulletList
            items={[
              'CE+ is assessed on the real environment: staff endpoints, identity providers, cloud accounts, and deployed services.',
              'The web app code matters, but provider configuration (Cloudflare/Vercel/AWS/Supabase) and staff device posture matters more.',
              'Evidence should cover both hosting modes: Vercel backend and AWS backend (behind Cloudflare routing).',
              'Avoid showing any customer data during assessment; use configuration screenshots and policies instead.',
            ]}
          />
        </Section>

        <Section title="3) How to use these pages during an assessment">
          <BulletList
            items={[
              'Print/save PDF of each evidence page and attach provider screenshots (MFA enabled, access reviews, retention, etc.).',
              'Keep an asset inventory list and update it whenever a new provider/service/device is introduced.',
              'Record periodic access reviews (who has admin access to Cloudflare/Vercel/AWS/Supabase/code hosting).',
              'Record patching cadence and evidence (OS updates, dependency updates, vulnerability remediation).',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
