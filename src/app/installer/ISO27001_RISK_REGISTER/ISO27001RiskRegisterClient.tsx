// Architecture: App Router surface src/app/installer/ISO27001_RISK_REGISTER/ISO27001RiskRegisterClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function ISO27001RiskRegisterClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 risk register</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only register template for Dinodia&apos;s ISMS-lite. Track risk owner, treatment, due date, and residual
            risk so the roadmap can be audited over time.
          </p>
        </div>

        <Section title="1) Minimum columns to keep">
          <CodeBlock
            code={[
              'Risk ID | Area | Threat | Impact | Likelihood | Inherent risk | Existing control | Treatment',
              'Owner | Due date | Residual risk | Status | Evidence link | Review date',
            ].join('\n')}
          />
        </Section>

        <Section title="2) Risk themes to track">
          <BulletList
            items={[
              'Authentication and account takeover, including password reset and session invalidation.',
              'IDOR and tenant isolation failures across tenant, admin, and installer support surfaces.',
              'SSRF or untrusted URL inputs in proxy and Home Assistant integration paths.',
              'Support-access misuse, including approval bypass or excessive impersonation duration.',
              'Logging leakage of secrets or customer data into operational logs or incident notes.',
              'Supplier drift, including missing DPA review, expired access, or unreviewed subprocessor changes.',
            ]}
          />
        </Section>

        <Section title="3) Treatment workflow">
          <BulletList
            items={[
              'Record the risk in the register before the change ships.',
              'Assign a clear owner and due date in Home Support or the audit tracker.',
              'Choose treatment: avoid, reduce, transfer, or accept with explicit approval.',
              'Attach evidence for implemented controls, testing, and review sign-off.',
              'Re-open the risk after incidents, major feature changes, or supplier changes.',
            ]}
          />
        </Section>

        <Section title="4) Review cadence">
          <BulletList
            items={[
              'Review at least monthly while building the ISMS-lite, then at a fixed audit cadence.',
              'Update immediately after a security incident, pentest finding, supplier change, or major release.',
              'Use Home Support as the operational entry point for ownership and evidence gathering.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
