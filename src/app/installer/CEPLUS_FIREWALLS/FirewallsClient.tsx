// Architecture: App Router surface src/app/installer/CEPLUS_FIREWALLS/FirewallsClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function FirewallsClient({ installerName }: { installerName: string }) {
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
              href="/installer/CYBER_ESSENTIALS_PLUS"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              CE+ Overview
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
          <h1 className="text-2xl font-semibold text-slate-900">CE+ firewalls and network boundary evidence</h1>
          <p className="mt-2 text-sm text-slate-600">
            CE+ requires that network boundaries are protected. For Dinodia, the main boundaries are Cloudflare edge,
            Vercel/AWS ingress, and internal AWS security groups. This page lists what to enforce and what evidence to
            capture.
          </p>
        </div>

        <Section title="1) Cloudflare edge controls">
          <BulletList
            items={[
              'Ensure only required routes are exposed publicly.',
              'Use Cloudflare WAF/firewall rules to reduce abuse and block known-bad traffic where appropriate.',
              'Enable bot protections/rate limiting where appropriate (especially auth endpoints).',
              'Restrict Cloudflare dashboard access and enforce MFA.',
            ]}
          />
        </Section>

        <Section title="2) Vercel-mode (dinodia-platform) boundary">
          <BulletList
            items={[
              'Confirm HTTPS enforced end-to-end; HSTS enabled in production.',
              'Restrict Vercel project access to minimal team members; protect environment variables.',
              'Treat logs and build artifacts as sensitive; restrict access and set retention.',
            ]}
          />
        </Section>

        <Section title="3) AWS-mode (dinodia-platform-aws) boundary">
          <BulletList
            items={[
              'Security groups allow only required inbound ports from the load balancer; no direct public admin ports.',
              'Restrict outbound where practical; ensure secrets are not exposed in task definitions/logs.',
              'Set CloudWatch log retention and restrict log access.',
            ]}
          />
        </Section>

        <Section title="4) Evidence to show (examples)">
          <BulletList
            items={[
              'Screenshots: Cloudflare firewall rules/WAF settings.',
              'Screenshots: AWS security group inbound/outbound rules and load balancer listener configuration.',
              'Screenshots: Vercel project settings showing access controls and environment variable protection.',
              'Documented boundary diagram for Vercel-mode and AWS-mode deployments.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
