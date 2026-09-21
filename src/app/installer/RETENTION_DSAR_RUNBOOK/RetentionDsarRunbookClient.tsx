// Architecture: App Router surface src/app/installer/RETENTION_DSAR_RUNBOOK/RetentionDsarRunbookClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function RetentionDsarRunbookClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">Retention + DSAR runbook (operational)</h1>
          <p className="mt-2 text-sm text-slate-600">
            This is a lightweight operational runbook for GDPR data retention and DSAR handling. It should be refined over time,
            but is safe to print as evidence that processes exist.
          </p>
        </div>

        <Section title="1) Retention schedule (baseline)">
          <BulletList
            items={[
              'Define retention per data category (account data, audit logs, device events, support tickets, backups).',
              'Set a default retention period and justify it (security, contractual, legal).',
              'Ensure logs/backups follow the same retention and access controls (they contain personal data).',
              'Document where retention is configured (Supabase/DB, Cloudflare logs, Vercel/AWS logs, S3 backups, email provider).',
            ]}
          />
        </Section>

        <Section title="2) DSAR workflow (export / delete / rectify)">
          <BulletList
            items={[
              'Identity verification: verify the requester owns the account (email + device verification) before fulfilling DSAR.',
              'Export: provide a structured export (account profile, homes/areas membership, audit events, support access approvals).',
              'Rectify: correct incorrect personal data (email/phone/name/address) with audit-trail where appropriate.',
              'Delete/anonymise: remove or anonymise personal data unless retention is required for legal/security reasons; document exemptions.',
              'Timing: record request received date and target response date; track progress and evidence of fulfilment.',
            ]}
          />
        </Section>

        <Section title="3) Evidence to keep (what auditors expect)">
          <BulletList
            items={[
              'A dated retention schedule document (table of categories + durations + storage location).',
              'A DSAR checklist template with fields: requester, verification method, scope, outcome, dates, approver.',
              'Access logs showing only authorized Dinodia staff handled DSAR actions (least privilege).',
              'Proof that backups/logs are included in retention controls (or a documented exception with mitigation).',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
