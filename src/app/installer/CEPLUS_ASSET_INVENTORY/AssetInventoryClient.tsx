// Architecture: App Router surface src/app/installer/CEPLUS_ASSET_INVENTORY/AssetInventoryClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function AssetInventoryClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">CE+ asset inventory checklist</h1>
          <p className="mt-2 text-sm text-slate-600">
            CE+ evidence requires a maintained asset inventory. This page is a checklist; keep an internal spreadsheet
            or inventory tool updated, and attach the latest export during assessment.
          </p>
        </div>

        <Section title="1) People and access">
          <BulletList
            items={[
              'List all Dinodia staff with privileged access (Cloudflare/Vercel/AWS/Supabase/code hosting).',
              'Record role for each person (admin vs developer vs support) and justification.',
              'Record MFA enforcement for each identity provider and when last access review occurred.',
            ]}
          />
        </Section>

        <Section title="2) Staff endpoints (laptops/desktops/phones)">
          <BulletList
            items={[
              'List every staff laptop/desktop used to administer production (owner, OS, serial/identifier, encryption status).',
              'Confirm malware protection is enabled and centrally managed (or documented).',
              'Confirm OS patching cadence and that devices are configured with screen lock + strong auth.',
            ]}
          />
        </Section>

        <Section title="3) Cloud accounts and services (must cover both hosting modes)">
          <BulletList
            items={[
              'Cloudflare (DNS, WAF/firewall rules, routing to Vercel/AWS).',
              'Vercel (dinodia-platform deployment + env vars + logs).',
              'AWS (dinodia-platform-aws infra: ECS/LB/security groups/CloudWatch/log retention).',
              'Supabase/Postgres (projects, DB roles, backups, access controls).',
              'Email provider (sending domains, templates, suppression lists, access controls).',
              'Code hosting + CI (GitHub/GitLab/etc): org owners, repo admins, secrets, runners.',
            ]}
          />
        </Section>

        <Section title="4) Application assets">
          <BulletList
            items={[
              'All public domains/subdomains used by the system.',
              'All production/staging environments and their base URLs.',
              'All third-party integrations that process data (Alexa, Home Assistant connectivity, payment provider if any).',
              'Where secrets live (secret manager, env vars) and who can access them.',
            ]}
          />
        </Section>

        <Section title="5) Evidence to show (examples)">
          <BulletList
            items={[
              'Export of asset inventory with last-updated date and owner.',
              'Screenshots showing MFA enabled and enforced for admin consoles.',
              'Screenshots showing device encryption enabled and patching policy in place (MDM if available).',
              'Change management records for adding/removing privileged access.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
