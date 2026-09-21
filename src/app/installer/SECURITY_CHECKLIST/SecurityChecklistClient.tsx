// Architecture: App Router surface src/app/installer/SECURITY_CHECKLIST/SecurityChecklistClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Link from 'next/link';

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-2 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-50 ring-1 ring-slate-900/20">
      <code>{code}</code>
    </pre>
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

export default function SecurityChecklistClient({ installerName }: { installerName: string }) {
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
          <h1 className="text-2xl font-semibold text-slate-900">Security Checklist (DB visibility + break-glass)</h1>
          <p className="mt-2 text-sm text-slate-600">
            Evidence page describing the measures and runbook used to reduce production database visibility and
            restrict direct data access. This is intended for Dinodia staff and audits.
          </p>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Purpose</h2>
          <BulletList
            items={[
              'Ensure production data access is least-privilege by default (runtime vs migrations).',
              'Remove broad grants from default/public roles and Supabase API roles where present.',
              'Create a controlled break-glass workflow for direct SQL access with ticketing and auditing.',
            ]}
          />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">What we do (high level)</h2>
          <BulletList
            items={[
              'Use group roles: dinodia_runtime_role (app traffic) and dinodia_migration_role (controlled migrations).',
              'Rotate app credentials so DATABASE_URL uses the runtime login and DIRECT_URL uses the migration login.',
              'Restrict Supabase production visibility (SQL editor, backups, logs) to minimum staff.',
              'Require a break-glass ticket + audit log before any direct production query.',
            ]}
          />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Runbook: apply SQL hardening</h2>
          <p className="mt-2 text-sm text-slate-600">
            Run from the repo root (staging first, then production). This uses the existing script:
            <span className="font-mono"> scripts/supabase_privacy_hardening.sql</span>
          </p>
          <CodeBlock
            code={[
              'cd dinodia-platform',
              'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/supabase_privacy_hardening.sql',
            ].join('\n')}
          />
          <p className="mt-4 text-sm text-slate-600">
            Expected outcomes:
          </p>
          <BulletList
            items={[
              'Creates dinodia_runtime_role and dinodia_migration_role if missing.',
              'Revokes broad grants from PUBLIC and from anon/authenticated roles when present.',
              'Grants least-privilege DML access to runtime role and elevated privileges to migration role.',
              'Creates audit.break_glass_access_log and audit.log_break_glass_access() for controlled access logging.',
              'Enables/configures pgaudit when available (environment dependent).',
            ]}
          />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Runbook: create dedicated login users (once)</h2>
          <p className="mt-2 text-sm text-slate-600">
            After the hardening script, create dedicated LOGIN roles and grant group roles. Use strong unique
            passwords and store them in your secret manager.
          </p>
          <CodeBlock
            code={[
              "CREATE ROLE dinodia_runtime_login LOGIN PASSWORD '<strong-runtime-password>';",
              "CREATE ROLE dinodia_migration_login LOGIN PASSWORD '<strong-migration-password>';",
              'GRANT dinodia_runtime_role TO dinodia_runtime_login;',
              'GRANT dinodia_migration_role TO dinodia_migration_login;',
              'ALTER ROLE dinodia_runtime_login BYPASSRLS;',
              'ALTER ROLE dinodia_migration_login BYPASSRLS;',
            ].join('\n')}
          />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Runbook: rotate app DB credentials</h2>
          <BulletList
            items={[
              'Set DATABASE_URL to use dinodia_runtime_login.',
              'Set DIRECT_URL to use dinodia_migration_login.',
              'Run prisma deploy, lint, and build from the repo root before deploying.',
            ]}
          />
          <CodeBlock code={['npm run prisma:deploy', 'npm run lint', 'npm run build'].join('\n')} />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Break-glass workflow (required)</h2>
          <BulletList
            items={[
              'Open a ticket with scope + reason + approver before any direct production query.',
              'Log break-glass access start in audit.break_glass_access_log.',
              'Run the minimum scoped queries needed to resolve the issue.',
              'Record completion notes + reviewer in the break-glass log.',
            ]}
          />
          <CodeBlock
            code={[
              "SELECT audit.log_break_glass_access(",
              "  '<actor-email>',",
              "  '<ticket-id>',",
              "  '<reason>',",
              "  'start'",
              ');',
            ].join('\n')}
          />
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Post-change verification queries</h2>
          <CodeBlock
            code={[
              'SELECT grantee, table_name, privilege_type',
              'FROM information_schema.table_privileges',
              "WHERE table_schema = 'public'",
              "  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'dinodia_runtime_role', 'dinodia_migration_role')",
              'ORDER BY grantee, table_name, privilege_type;',
            ].join('\n')}
          />
          <p className="mt-4 text-sm text-slate-600">
            Expected: <span className="font-semibold">PUBLIC</span>, <span className="font-semibold">anon</span>, and{' '}
            <span className="font-semibold">authenticated</span> do not retain broad table privileges; runtime has DML;
            migration has elevated privileges.
          </p>
        </section>
      </div>
    </div>
  );
}
