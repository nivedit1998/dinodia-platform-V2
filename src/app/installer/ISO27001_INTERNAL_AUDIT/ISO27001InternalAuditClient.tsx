// Architecture: App Router surface src/app/installer/ISO27001_INTERNAL_AUDIT/ISO27001InternalAuditClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100">
      <code>{code}</code>
    </pre>
  );
}

export default function ISO27001InternalAuditClient({ installerName }: { installerName: string }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">Installer</p>
            <p className="text-lg font-semibold text-slate-900">{installerName}</p>
          </div>
          <div className="flex gap-2">
            <Link href="/installer/GDPR_Status" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
              Back to GDPR Status
            </Link>
            <Link href="/installer/HomeSupport" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
              Home Support
            </Link>
            <Link href="/companylogin/login" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
              Sign out
            </Link>
          </div>
        </header>

        <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 internal audit</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only audit page for the annual or quarterly ISMS-lite review. Keep audit findings, corrective
            actions, and evidence links here.
          </p>
        </div>

        <Section title="1) Audit cycle">
          <BulletList
            items={[
              'Set the audit date and control owner before the review begins.',
              'Sample the evidence pages, support workflow, and a small set of real change records.',
              'Record findings, severity, owner, due date, and status for each action item.',
            ]}
          />
        </Section>

        <Section title="2) Control areas to test">
          <BulletList
            items={[
              'Scope statement and supplier register are current and approved.',
              'Risk register has owners, treatment decisions, and evidence links.',
              'Incident response records exist and use Home Support for intake and follow-up.',
              'Support access approvals are time-limited, auditable, and consistent with policy.',
              'Logs and error handling do not expose secrets or customer data.',
            ]}
          />
        </Section>

        <Section title="3) Corrective action tracker template">
          <CodeBlock
            code={[
              'Finding ID | Control | Description | Severity | Owner | Due date | Status | Evidence link',
              'ACTIONS: triage, fix, verify, retest, close',
            ].join('\n')}
          />
        </Section>

        <Section title="4) Evidence pack contents">
          <BulletList
            items={[
              'Scope statement, supplier register, and risk register export or PDF.',
              'Support request or incident examples showing approvals and traceability.',
              'Screenshots or PDFs of the evidence pages used to support the audit.',
              'A final management sign-off and retest note for any open items.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
