// Architecture: App Router surface src/app/installer/CEPLUS_SECURE_CONFIGURATION/SecureConfigurationClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-2 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-50 ring-1 ring-slate-900/20">
      <code>{code}</code>
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

export default function SecureConfigurationClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">CE+ secure configuration baseline</h1>
          <p className="mt-2 text-sm text-slate-600">
            Secure configuration is a CE+ control area. This page documents baseline settings for web/app and for
            providers (Cloudflare/Vercel/AWS/Supabase). Capture screenshots as evidence.
          </p>
        </div>

        <Section title="1) Web security headers (baseline)">
          <p className="text-sm text-slate-600">
            Both backends set baseline security headers in <span className="font-mono">next.config.ts</span>.
            Validate via automated check:
          </p>
          <CodeBlock code={['cd dinodia-platform', 'npm run check:security'].join('\n')} />
          <BulletList
            items={[
              'HSTS enabled in production only.',
              'X-Content-Type-Options: nosniff',
              'Referrer-Policy',
              'X-Frame-Options',
              'Permissions-Policy',
            ]}
          />
        </Section>

        <Section title="2) Cookies and session handling (baseline)">
          <BulletList
            items={[
              'Auth cookies should be HttpOnly and Secure in production.',
              'Prefer SameSite=Lax for typical auth flows unless a specific cross-site flow requires otherwise.',
              'Rotate secrets and separate runtime vs migration DB credentials (see Security Checklist).',
            ]}
          />
        </Section>

        <Section title="3) Provider secure configuration (must cover both hosting modes)">
          <BulletList
            items={[
              'Cloudflare: restrict dashboard access, enforce MFA, configure WAF/firewall rules and bot protections as appropriate.',
              'Vercel: restrict team membership, protect env vars, restrict preview deployments for sensitive branches.',
              'AWS: security groups least privilege, S3 public access blocks where applicable, CloudWatch retention set.',
              'Supabase: restrict SQL editor/backups access, enforce least privilege DB roles, rotate credentials.',
            ]}
          />
        </Section>

        <Section title="4) Evidence to show (examples)">
          <BulletList
            items={[
              'Screenshots: security headers verified (or automated script output).',
              'Screenshots: Cloudflare/Vercel/AWS/Supabase configuration pages (MFA, access lists, security groups).',
              'Documented secure configuration baseline and change management notes.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
