// Architecture: App Router surface src/app/installer/LOGGING_POLICY/LoggingPolicyClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
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

export default function LoggingPolicyClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">Logging policy (no PII / no secrets)</h1>
          <p className="mt-2 text-sm text-slate-600">
            Internal policy for how Dinodia logs must be written to reduce the chance of personal data or secrets
            appearing in logs. Keep this page updated as the codebase evolves.
          </p>
        </div>

        <Section title="1) Non-negotiables">
          <BulletList
            items={[
              'Never log passwords, passcodes, tokens, cookies, authorization headers, or secrets.',
              'Never log request bodies for auth endpoints (login, password reset, verification).',
              'Never log raw third-party OAuth response bodies (success or failure).',
              'Treat logs as personal data: restrict access and set retention periods.',
            ]}
          />
        </Section>

        <Section title="2) Allowed identifiers (must be hashed/pseudonymised before logging)">
          <BulletList
            items={[
              'Client IP address (log only as ipHash).',
              'Device identifiers (log only as deviceIdHash).',
              'Hub serial numbers (log only as serialHash).',
              'Database IDs that link to a person/home (log only as userIdHash/homeIdHash/haConnectionIdHash where needed).',
            ]}
          />
        </Section>

        <Section title="3) Approved logging utilities (server)">
          <p className="text-sm text-slate-600">
            Use the sanitised logger helpers instead of raw <span className="font-mono">console.*</span>.
          </p>
          <BulletList
            items={[
              'Preferred: safeLog + sanitisation: src/lib/safeLogger.ts',
              'Preferred for errors: src/lib/serverErrorLog.ts (standardised error logging)',
              'Structured request hit logging: src/lib/requestLog.ts (hashes IP + device ID)',
            ]}
          />
          <CodeBlock
            code={[
              "import { logServerError } from '@/lib/serverErrorLog';",
              '',
              'try {',
              '  // ...',
              '} catch (err) {',
              "  logServerError('[route] unhandled', err, { userId });",
              '}',
            ].join('\n')}
          />
        </Section>

        <Section title="4) Forbidden patterns (must fail review)">
          <BulletList
            items={[
              'console.error(err) in server routes/libs.',
              'Logging res.text() or res.json() bodies from OAuth/token endpoints.',
              'Interpolating email/phone/address into log strings.',
            ]}
          />
        </Section>

        <Section title="5) Operational controls (non-code)">
          <BulletList
            items={[
              'Restrict access to provider logs to a minimal on-call/security group.',
              'Set log retention periods per environment and document them.',
              'Maintain an incident workflow: who can access logs, when, and how access is recorded.',
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
