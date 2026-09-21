// Architecture: App Router surface src/app/installer/POLICY_ACCEPTANCE_EVIDENCE/PolicyAcceptanceEvidenceClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100">
      <code>{children}</code>
    </pre>
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

export default function PolicyAcceptanceEvidenceClient(props: {
  installerName: string;
  privacyVersion: string;
  termsVersion: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">Installer</p>
            <p className="text-lg font-semibold text-slate-900">{props.installerName}</p>
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
          <h1 className="text-2xl font-semibold text-slate-900">Policy acceptance — storage evidence</h1>
          <p className="mt-2 text-sm text-slate-600">
            This page documents how Dinodia records policy acceptance. It is designed to be shown during GDPR/privacy
            reviews without exposing any customer content in logs or on-screen.
          </p>
        </div>

        <Section title="1) What we store (minimum viable evidence)">
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Policy kind: <span className="font-semibold">PRIVACY_NOTICE</span> or <span className="font-semibold">TERMS</span></li>
            <li>Policy version string (e.g. {props.privacyVersion} / {props.termsVersion})</li>
            <li>Acceptance timestamp</li>
            <li>
              Optional hashed metadata (no raw IP/device identifiers stored in logs): <span className="font-semibold">ipHash</span>,{' '}
              <span className="font-semibold">deviceFingerprintHash</span>
            </li>
          </ul>
          <p className="mt-3 text-sm text-slate-600">
            Acceptance is stored <span className="font-semibold">per user</span> (not per home), with a unique constraint to avoid duplicate rows
            for the same user + policy kind + version.
          </p>
        </Section>

        <Section title="2) API surfaces (where acceptance is enforced/recorded)">
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li><span className="font-semibold">GET</span> <span className="font-mono">/api/policy/status</span> — returns current versions + accepted booleans.</li>
            <li><span className="font-semibold">POST</span> <span className="font-mono">/api/policy/accept</span> — records acceptance for the current versions only (guards against stale versions).</li>
            <li><span className="font-semibold">Tenant gate</span>: <span className="font-mono">/tenant/policy</span> blocks tenant UI until both acceptances exist.</li>
          </ul>
        </Section>

        <Section title="3) DB verification (runbook snippets)">
          <p className="text-sm text-slate-600">
            Use these snippets during an audit to verify acceptance is recorded, without printing any personal data.
            Adjust schema/table names if your DB differs.
          </p>
          <Code>
            {[
              '-- Show counts by policy/version (no PII)',
              'select "policyKind", "policyVersion", count(*) as count',
              'from "PolicyAcceptance"',
              'group by "policyKind", "policyVersion"',
              'order by "policyKind", "policyVersion";',
              '',
              '-- Spot-check that tenants cannot access tenant UI without acceptance',
              '-- (performed in the app, not SQL).',
            ].join('\n')}
          </Code>
        </Section>
      </div>
    </div>
  );
}
