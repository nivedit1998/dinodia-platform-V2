// Architecture: App Router surface src/app/installer/PRIVACY_POLICY_EVIDENCE/PrivacyPolicyEvidenceClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function PrivacyPolicyEvidenceClient(props: {
  installerName: string;
  privacyVersion: string;
  privacyLastUpdated: string;
  termsVersion: string;
  termsLastUpdated: string;
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
          <h1 className="text-2xl font-semibold text-slate-900">Privacy notice + Terms — publication evidence</h1>
          <p className="mt-2 text-sm text-slate-600">
            Internal evidence page to demonstrate Dinodia publishes a public Privacy Notice and Terms and surfaces them in product flows.
            Print/save this page and the linked public pages as part of an audit pack.
          </p>
        </div>

        <Section title="1) Public pages (what exists now)">
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Privacy Notice</p>
              <p className="mt-1 text-sm text-slate-700">
                URL:{' '}
                <Link href="/privacy" className="font-semibold underline underline-offset-2">
                  /privacy
                </Link>
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Version: <span className="font-semibold text-slate-900">{props.privacyVersion}</span> • Last updated:{' '}
                <span className="font-semibold text-slate-900">{props.privacyLastUpdated}</span>
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-900">Terms</p>
              <p className="mt-1 text-sm text-slate-700">
                URL:{' '}
                <Link href="/terms" className="font-semibold underline underline-offset-2">
                  /terms
                </Link>
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Version: <span className="font-semibold text-slate-900">{props.termsVersion}</span> • Last updated:{' '}
                <span className="font-semibold text-slate-900">{props.termsLastUpdated}</span>
              </p>
            </div>
          </div>
          <BulletList
            items={[
              'These pages are safe to show to auditors/customers (no authentication required).',
              'Versions are displayed; when the policy changes, bump the version/date and force re-acceptance for tenants.',
            ]}
          />
        </Section>

        <Section title="2) In-product surfacing (where users see links)">
          <BulletList
            items={[
              'Login / auth shell footer shows links to /privacy and /terms.',
              'Tenant app enforces a policy gate at /tenant/policy until both policies are accepted.',
              'Homeowner policy acceptance also records acceptance of the current privacy + terms versions.',
              'iOS app enforces the same tenant policy gate using the same backend endpoints.',
            ]}
          />
        </Section>

        <Section title="3) Manual checks (installer account)">
          <BulletList
            items={[
              'Visit /privacy and /terms in an incognito window to confirm they render publicly.',
              'Sign in as a tenant who has not accepted the latest versions; confirm redirect to /tenant/policy and that acceptance is required.',
              'After accepting, confirm tenant dashboard loads and /api/policy/status reports accepted=true for both.',
              'On iOS (tenant), confirm you cannot access the tenant UI until acceptance is completed.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
