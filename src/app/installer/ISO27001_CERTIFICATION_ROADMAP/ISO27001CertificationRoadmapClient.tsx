// Architecture: App Router surface src/app/installer/ISO27001_CERTIFICATION_ROADMAP/ISO27001CertificationRoadmapClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function ISO27001CertificationRoadmapClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 certification roadmap</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only roadmap for moving from ISMS-lite to certification-ready evidence. Keep the milestones printable
            and update them as scope, controls, or suppliers change.
          </p>
        </div>

        <Section title="1) Gap assessment">
          <BulletList
            items={[
              'Review the scope statement, supplier register, incident response process, and support workflow.',
              'Map current controls against Annex A or your chosen control set.',
              'Record the gaps, owner, and target date in the risk register.',
            ]}
          />
        </Section>

        <Section title="2) Control rollout">
          <BulletList
            items={[
              'Implement missing policies and operational controls.',
              'Assign each control an owner and a review cadence.',
              'Capture evidence in the relevant installer-only evidence page and keep the PDF version current.',
            ]}
          />
        </Section>

        <Section title="3) Internal audit and Stage 1">
          <BulletList
            items={[
              'Run an internal audit to confirm the evidence pack is complete and consistent.',
              'Tidy any missing records before a certification body reviews the documentation (Stage 1).',
              'Use Home Support as the operational entry point for evidence collection and ownership.',
            ]}
          />
        </Section>

        <Section title="4) Stage 2 and maintenance">
          <CodeBlock
            code={[
              'MILESTONES:',
              '1. Gap assessment complete',
              '2. Treatment plan approved',
              '3. Controls implemented',
              '4. Internal audit complete',
              '5. Stage 1 complete',
              '6. Stage 2 complete',
              '7. Ongoing review cadence in place',
            ].join('\n')}
          />
          <BulletList
            items={[
              'Keep the roadmap current after each incident, supplier change, or major release.',
              'Maintain a recurring review of scope, risk, supplier, and incident evidence.',
              'Keep the Home Support page as the staff-only contact and evidence collection hub.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
