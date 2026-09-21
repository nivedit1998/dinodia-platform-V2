// Architecture: App Router surface src/app/installer/ISO27001_SCOPE/ISO27001ScopeClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function ISO27001ScopeClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 scope statement</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only evidence page for the scope of the ISMS-lite. Keep this printable and update it when systems,
            suppliers, locations, or people change.
          </p>
        </div>

        <Section title="1) In scope">
          <BulletList
            items={[
              'Software and services used to operate the Dinodia smart living platform (web app, APIs, auth, policy flows, support tooling).',
              'Operational support and audit workflows captured in Home Support and the installer evidence pages.',
              'Supplier relationships that process or store Dinodia data (hosting, database, email, source control, monitoring, CDN/WAF).',
              'People who administer or support the platform: Dinodia staff using installer/support/admin routes and related approvals.',
              'Data processed to run the service: account details, home/tenant access data, logs, support records, and audit evidence.',
            ]}
          />
        </Section>

        <Section title="2) Out of scope">
          <BulletList
            items={[
              'Customer-owned devices, Wi-Fi, and local networks unless explicitly assessed for a support ticket or incident.',
              'Third-party provider internals beyond contract, configuration, and evidence available to Dinodia.',
              'Any personal devices or services not required to run, support, or secure the Dinodia platform.',
            ]}
          />
        </Section>

        <Section title="3) Locations and people">
          <BulletList
            items={[
              'Operational control is maintained by Dinodia staff only.',
              'Production support and audit work should be routed through Home Support so ownership and approvals are traceable.',
              'Evidence should record who approved a change, who performed it, and which environment was affected (Vercel or AWS).',
            ]}
          />
        </Section>

        <Section title="4) Review triggers and records">
          <BulletList
            items={[
              'Review this scope when a new supplier, environment, product surface, or support process is added.',
              'Record scope version, approver, change reason, and review date in the certification roadmap and audit log pages.',
              'Keep the GDPR Status roadmap in sync so the high-level page and the evidence pages tell the same story.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
