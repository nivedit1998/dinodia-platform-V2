// Architecture: App Router surface src/app/installer/ICO_EVIDENCE_PACK/IcoEvidencePackClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function IcoEvidencePackClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ICO registration evidence pack (internal)</h1>
          <p className="mt-2 text-sm text-slate-600">
            Internal evidence page to support ICO fee registration and demonstrate governance. Keep this page updated
            over time as Dinodia’s controls mature.
          </p>
        </div>

        <Section title="1) What we process (high-level categories)">
          <BulletList
            items={[
              'Account data: usernames, emails, password hashes, device trust identifiers.',
              'Home data: address fields for homeowner onboarding/terms acceptance.',
              'Tenant access data: area access rules for a given home.',
              'Smart-home operational data: device/entity identifiers, automation settings, hub token state and telemetry needed to operate service.',
              'Security/audit data: support access requests, approvals, impersonation events, break-glass access logs (where applicable).',
              'Logs: server and infrastructure logs used for reliability and security investigations (minimised and scrubbed).',
            ]}
          />
          <p className="mt-3 text-sm text-slate-600">
            Note: even “device IDs” and “home telemetry” can be personal data when linked to a household.
          </p>
        </Section>

        <Section title="2) Why we process it (purposes + typical lawful bases)">
          <BulletList
            items={[
              'Operate the smart-home service (contract).',
              'Authenticate users and secure accounts (contract + legitimate interests).',
              'Provision hubs and manage tenant access (contract).',
              'Provide customer support when requested; enforce time-limited support access with audit trail (legitimate interests / contract).',
              'Prevent abuse and investigate incidents (legitimate interests).',
            ]}
          />
          <p className="mt-3 text-sm text-slate-600">
            If you add non-essential analytics/marketing later, treat those as consent-based processing and keep them
            separate from service-critical processing.
          </p>
        </Section>

        <Section title="3) Technical and organisational measures (TOMs)">
          <BulletList
            items={[
              'Role-based access controls in the app (ADMIN / INSTALLER / TENANT).',
              'Installer/support access is designed to be explicit, time-limited, revocable, and auditable.',
              'Database visibility lockdown runbook and break-glass workflow (see Security Checklist).',
              'Logging controls to minimise secrets/PII and standardise error logging (see Logging Policy).',
              'Least privilege for production consoles (DB editor/backups/log access restricted to small staff set).',
            ]}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/installer/SECURITY_CHECKLIST"
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Open Security Checklist
            </Link>
            <Link
              href="/installer/LOGGING_POLICY"
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Open Logging Policy
            </Link>
          </div>
        </Section>

        <Section title="4) Retention schedule (placeholders — decide and fill in)">
          <BulletList
            items={[
              'Application logs: TODO define retention per provider/environment (treat logs as personal data).',
              'Audit events: TODO define retention (balance accountability vs minimisation).',
              'Support requests: TODO define retention.',
              'Backups: TODO define encryption, access control, and retention.',
              'Account deletion: TODO define erasure/anonymisation workflow and what must be retained for legal/security reasons.',
            ]}
          />
          <p className="mt-3 text-sm text-slate-600">
            For audits, it’s better to have explicit retention numbers and access control procedures than “we keep it
            forever”.
          </p>
        </Section>

        <Section title="5) Processors / subprocessors (placeholders — confirm in production)">
          <BulletList
            items={[
              'Hosting/CDN: Vercel (platform) and AWS + Cloudflare (aws platform).',
              'Database: Supabase / Postgres.',
              'Email delivery: TODO confirm provider and DPA.',
              'Integrations: Amazon Alexa; Home Assistant connectivity (user environment).',
              'Source control/CI: TODO confirm provider and access controls.',
            ]}
          />
          <p className="mt-3 text-sm text-slate-600">
            Maintain a list of subprocessors, data locations, and DPAs as part of your compliance pack.
          </p>
        </Section>
      </div>
    </div>
  );
}
