// Architecture: App Router surface src/app/installer/ISO27001_SUPPLIER_REGISTER/ISO27001SupplierRegisterClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function ISO27001SupplierRegisterClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 supplier register</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only supplier record for the ISMS-lite. Keep it printable and update it whenever a service,
            contract, or subprocessor changes.
          </p>
        </div>

        <Section title="1) Suppliers to keep in the register">
          <BulletList
            items={[
              'Cloudflare for routing, CDN, WAF, and edge controls.',
              'Vercel for platform hosting and deployment pipeline.',
              'AWS for the alternate backend path and infrastructure services.',
              'Supabase or Postgres for database and data services.',
              'Source control and CI provider used to store code and build evidence.',
              'Email and monitoring providers that handle operational notifications or evidence.',
            ]}
          />
        </Section>

        <Section title="2) Fields to record per supplier">
          <BulletList
            items={[
              'Supplier name, service, environment, and business owner.',
              'Data processed, storage location, and whether a DPA is in place.',
              'Security review date, contract renewal date, and any open issues.',
              'Subprocessor list or references if the supplier exposes one.',
              'Incident contact, escalation path, and evidence of periodic review.',
            ]}
          />
        </Section>

        <Section title="3) Review process">
          <BulletList
            items={[
              'Review each supplier after major changes, incidents, or contract renewals.',
              'Record review evidence in Home Support or the audit tracker, then link the evidence page.',
              'Do not keep customer PII in supplier notes; keep the record focused on governance and security.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
