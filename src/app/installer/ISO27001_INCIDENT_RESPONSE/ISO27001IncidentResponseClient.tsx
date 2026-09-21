// Architecture: App Router surface src/app/installer/ISO27001_INCIDENT_RESPONSE/ISO27001IncidentResponseClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function ISO27001IncidentResponseClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">ISO 27001 incident response</h1>
          <p className="mt-2 text-sm text-slate-600">
            Staff-only runbook for incident triage, containment, notification, and lessons learned. Keep this page
            printable and linked from the support hub.
          </p>
        </div>

        <Section title="1) Triage and containment">
          <BulletList
            items={[
              'Use Home Support to record the incident owner, affected system, and ticket ID.',
              'Confirm the impact window, affected supplier, and whether customer data or secrets may be exposed.',
              'Take the minimum containment action required to stop further impact and document it immediately.',
            ]}
          />
        </Section>

        <Section title="2) Notification and escalation">
          <BulletList
            items={[
              'Escalate to the Dinodia staff approver and relevant supplier contact if a provider is involved.',
              'Record whether any privacy, security, or contractual notification is required.',
              'Note decision timestamps, approvers, and the reason for any delayed notification.',
            ]}
          />
        </Section>

        <Section title="3) Evidence to retain">
          <BulletList
            items={[
              'Timeline of events, logs with secrets redacted, and the exact impacted surface or route.',
              'Actions taken for containment, recovery, and verification.',
              'Post-incident review notes, corrective actions, and the follow-up audit ticket.',
            ]}
          />
        </Section>

        <Section title="4) Lessons learned">
          <BulletList
            items={[
              'Capture what failed, what worked, and what must change in code, process, or supplier management.',
              'Link the corrective action back to the risk register and internal audit pages.',
              'Keep the learning summary concise enough to print during an audit.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
