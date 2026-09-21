// Architecture: App Router surface src/app/installer/GDPR_Status/GdprStatusClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import Link from 'next/link';
import type { Route } from 'next';

type InstallerRunbookRoute =
  | '/installer/SECURITY_CHECKLIST'
  | '/installer/SUPABASE_PRIVACY_HARDENING'
  | '/installer/ICO_EVIDENCE_PACK'
  | '/installer/LOGGING_POLICY'
  | '/installer/CYBER_ESSENTIALS_PLUS'
  | '/installer/CEPLUS_ASSET_INVENTORY'
  | '/installer/CEPLUS_ACCESS_CONTROL'
  | '/installer/CEPLUS_SECURE_CONFIGURATION'
  | '/installer/CEPLUS_PATCH_MANAGEMENT'
  | '/installer/CEPLUS_MALWARE_PROTECTION'
  | '/installer/CEPLUS_FIREWALLS'
  | '/installer/PRIVACY_POLICY_EVIDENCE'
  | '/installer/POLICY_ACCEPTANCE_EVIDENCE'
  | '/installer/RETENTION_DSAR_RUNBOOK'
  | '/installer/PENTEST_SCOPE_ROE'
  | '/installer/PENTEST_REMEDIATION_LOG'
  | '/installer/ISO27001_SCOPE'
  | '/installer/ISO27001_RISK_REGISTER'
  | '/installer/ISO27001_SUPPLIER_REGISTER'
  | '/installer/ISO27001_INCIDENT_RESPONSE'
  | '/installer/ISO27001_INTERNAL_AUDIT'
  | '/installer/ISO27001_CERTIFICATION_ROADMAP';

type Section = {
  id: string;
  title: string;
  currentGood: string[];
  currentBad: string[];
  improvements: string[];
  steps: Array<{ label: string; href?: string; internal?: boolean }>;
  runbooksTitle?: string;
  runbooks?: Array<{ label: string; href: InstallerRunbookRoute }>;
};

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700"
    >
      {label}
    </a>
  );
}

function SectionCard({ section }: { section: Section }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{section.title}</h2>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current (good)</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {section.currentGood.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current (gaps / risks)</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {section.currentBad.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Improvements</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {section.improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps / records</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {section.steps.map((step) => (
              <li key={step.label}>
                {step.href ? (
                  step.internal ? (
                    <a
                      href={step.href}
                      className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700"
                    >
                      {step.label}
                    </a>
                  ) : (
                    <ExternalLink href={step.href} label={step.label} />
                  )
                ) : (
                  step.label
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {section.runbooks?.length ? (
        <div className="mt-4">
          <div className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {section.runbooksTitle || 'Runbooks (print / save as PDF)'}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {section.runbooks.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href as Route}
                    className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function GdprStatusClient({ installerName }: { installerName: string }) {
  const sections: Section[] = [
    {
      id: 'ico',
      title: 'ICO registration',
      currentGood: [
        'Security runbooks exist for database privacy hardening and break-glass access logging.',
        'Server logging is sanitised and stable identifiers are hashed/pseudonymised for safer diagnostics.',
        'Error logging is standardised to avoid logging raw OAuth/token response bodies.',
      ],
      currentBad: [
        'Log retention, access control, and production log review workflow must be defined operationally (treat logs as personal data).',
        'Retention schedule and processor/subprocessor list must be finalised for the ICO evidence pack.',
      ],
      improvements: [
        'Complete ICO fee registration and keep the registration certificate on file.',
        'Set explicit log retention periods in each provider and restrict log access to least privilege.',
        'Fill in retention periods and processor list in the ICO evidence pack page.',
      ],
      steps: [
        {
          label: 'Register / pay the ICO data protection fee',
          href: 'https://ico.org.uk/for-organisations/data-protection-fee/register/',
        },
        {
          label: 'GOV.UK entry point (data protection register / notify ICO)',
          href: 'https://www.gov.uk/data-protection-register-notify-ico-personal-data',
        },
        {
          label: 'ICO register of fee payers (download certificate)',
          href: 'https://ico.org.uk/about-the-ico/what-we-do/register-of-fee-payers/',
        },
      ],
      runbooksTitle: 'Runbooks (print / save as PDF)',
      runbooks: [
        { label: 'Security checklist (DB visibility lockdown + break-glass)', href: '/installer/SECURITY_CHECKLIST' },
        { label: 'Supabase privacy hardening (SQL)', href: '/installer/SUPABASE_PRIVACY_HARDENING' },
        { label: 'ICO registration evidence pack (internal)', href: '/installer/ICO_EVIDENCE_PACK' },
        { label: 'Logging policy (no PII / no secrets)', href: '/installer/LOGGING_POLICY' },
      ],
    },
    {
      id: 'ceplus',
      title: 'Cyber Essentials Plus',
      currentGood: [
        'CE+ evidence pages exist (asset inventory, access control/MFA, secure configuration, patching, malware protection, firewalls).',
        'Baseline security headers are centrally defined in next.config.ts and verified by an automated check.',
        'Access control patterns are in place (role separation, installer-only routes, least-privilege DB hardening runbooks).',
      ],
      currentBad: [
        'Most CE+ requirements are operational: you still need real provider/device evidence (screenshots/reports) for Cloudflare, Vercel, AWS, Supabase, code hosting, and staff endpoints.',
        'Asset inventory must be maintained continuously (not just at audit time) and kept current as services/devices change.',
      ],
      improvements: [
        'Fill the evidence pages with dated screenshots and reports (MFA enforcement, access reviews, patch compliance, EDR status, firewall/WAF rules).',
        'Schedule and document quarterly access reviews across Cloudflare/Vercel/AWS/Supabase/code hosting/email provider.',
        'Define and enforce log retention/access controls in each provider (logs/backups are sensitive surfaces).',
      ],
      steps: [
        { label: 'Cyber Essentials (IASME) overview', href: 'https://iasme.co.uk/cyber-essentials/' },
        { label: 'Cyber Essentials Plus overview', href: 'https://iasme.co.uk/cyber-essentials/plus/' },
        { label: 'Choose an IASME Certification Body, agree scope, and schedule assessment.' },
        { label: 'Print/save each evidence page to PDF and attach provider screenshots for the audit pack.' },
      ],
      runbooksTitle: 'Evidence pages (print / save as PDF)',
      runbooks: [
        { label: 'CE+ overview and audit prep', href: '/installer/CYBER_ESSENTIALS_PLUS' },
        { label: 'Asset inventory checklist', href: '/installer/CEPLUS_ASSET_INVENTORY' },
        { label: 'Access control and MFA evidence', href: '/installer/CEPLUS_ACCESS_CONTROL' },
        { label: 'Secure configuration baseline', href: '/installer/CEPLUS_SECURE_CONFIGURATION' },
        { label: 'Patch management policy', href: '/installer/CEPLUS_PATCH_MANAGEMENT' },
        { label: 'Malware protection policy', href: '/installer/CEPLUS_MALWARE_PROTECTION' },
        { label: 'Firewalls and network boundary evidence', href: '/installer/CEPLUS_FIREWALLS' },
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy policy',
      currentGood: [
        'Public `/privacy` and `/terms` pages are published and versioned.',
        'Tenants are policy-gated: tenant pages require acceptance of both Privacy Notice + Terms (stored per user + version + timestamp).',
        'Homeowner policy acceptance also records acceptance of the current Privacy Notice + Terms versions (stored per user).',
        'iOS tenant flow enforces the same acceptance requirement using the same backend endpoints.',
      ],
      currentBad: [
        'Privacy/terms content should be reviewed periodically (processors, retention, and lawful basis details can drift as providers/features change).',
        'Retention/DSAR processes are mostly operational: evidence must be maintained in providers (Cloudflare/Vercel/AWS/Supabase/email).',
      ],
      improvements: [
        'Maintain a quarterly review cadence: update privacy notice versions when data categories/processors/retention changes.',
        'Keep DSAR/retention runbooks current and attach dated evidence (exports, deletion/anonymisation decisions, retention configs).',
      ],
      steps: [
        { label: 'Review `/privacy` and `/terms` content, then bump the policy version/date when materially changed.' },
        { label: 'Verify tenant gating: tenants must accept both policies before accessing tenant UI (web + iOS).' },
        { label: 'Maintain a retention schedule and DSAR workflow (export/delete/anonymise as policy requires).' },
      ],
      runbooksTitle: 'Evidence pages (print / save as PDF)',
      runbooks: [
        { label: 'Privacy + Terms publication evidence', href: '/installer/PRIVACY_POLICY_EVIDENCE' },
        { label: 'Policy acceptance storage evidence', href: '/installer/POLICY_ACCEPTANCE_EVIDENCE' },
        { label: 'Retention + DSAR runbook', href: '/installer/RETENTION_DSAR_RUNBOOK' },
      ],
    },
    {
      id: 'pentest',
      title: 'Penetration testing',
      currentGood: [
        'Installer/admin/tenant roles are explicit in the data model and routing.',
        'Installer support actions are designed to require explicit approval and are auditable.',
        'Pentest scope + Rules of Engagement (RoE) and remediation tracking pages exist (installer-only) to support audits.',
        'Server-side logging guardrails exist (no unsafe logs check + sanitised error logging) to reduce risk of PII/secrets in logs.',
      ],
      currentBad: [
        'Pentest execution is operational: you still need a tester/provider, dates, environment scoping, and evidence pack management.',
        'Any findings must be remediated and re-tested against both hosting modes (Vercel + AWS) to maintain parity switching.',
      ],
      improvements: [
        'Keep scope/RoE current as features/providers change (auth flows, support tooling, public endpoints).',
        'Maintain a remediation log and re-test evidence pack (screenshots/PDFs) after fixes.',
      ],
      steps: [
        { label: 'Engage a qualified penetration testing provider (agree scope + RoE).'},
        { label: 'Run test against both hosting modes (Vercel + AWS) to validate parity switching.' },
        { label: 'Produce report + remediation plan + retest evidence pack.' },
      ],
      runbooksTitle: 'Evidence pages (print / save as PDF)',
      runbooks: [
        { label: 'Pentest scope + Rules of Engagement (RoE)', href: '/installer/PENTEST_SCOPE_ROE' },
        { label: 'Remediation log + re-test plan', href: '/installer/PENTEST_REMEDIATION_LOG' },
      ],
    },
    {
      id: 'iso27001',
      title: 'ISO 27001 roadmap',
      currentGood: [
        'Home Support already exists as the staff-only operational support hub for approvals, impersonation, and audit follow-up.',
        'Audit-event structures and log-safe helpers exist to support accountability and traceability.',
        'Installer-only ISO evidence pages now exist for scope, risk, suppliers, incidents, internal audit, and certification roadmap.',
      ],
      currentBad: [
        'ISO 27001 still requires a formal ISMS-lite operating model: scope, risk register, supplier management, incident response, internal audit, and certification discipline.',
        'Control ownership and evidence collection need to stay current as systems, suppliers, and support processes change.',
      ],
      improvements: [
        'Use Home Support as the operational support/contact hub, then capture the real ISO records in the new evidence pages.',
        'Keep a roadmap with milestones: gap assessment, control rollout, internal audit, Stage 1, Stage 2, and ongoing maintenance.',
      ],
      steps: [
        { label: 'Open Home Support and confirm it is the staff-only support hub for audit and support ownership.', href: '/installer/HomeSupport', internal: true },
        { label: 'Define ISO 27001 scope (systems, people, locations, suppliers).', href: '/installer/ISO27001_SCOPE', internal: true },
        { label: 'Perform a gap assessment and build a risk treatment plan.', href: '/installer/ISO27001_RISK_REGISTER', internal: true },
        { label: 'Track suppliers, incidents, internal audits, and certification milestones in the dedicated evidence pages.', href: '/installer/ISO27001_SUPPLIER_REGISTER', internal: true },
      ],
      runbooksTitle: 'Evidence pages (print / save as PDF)',
      runbooks: [
        { label: 'ISO 27001 scope statement', href: '/installer/ISO27001_SCOPE' },
        { label: 'ISO 27001 risk register', href: '/installer/ISO27001_RISK_REGISTER' },
        { label: 'ISO 27001 supplier register', href: '/installer/ISO27001_SUPPLIER_REGISTER' },
        { label: 'ISO 27001 incident response', href: '/installer/ISO27001_INCIDENT_RESPONSE' },
        { label: 'ISO 27001 internal audit', href: '/installer/ISO27001_INTERNAL_AUDIT' },
        { label: 'ISO 27001 certification roadmap', href: '/installer/ISO27001_CERTIFICATION_ROADMAP' },
      ],
    },
  ];

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
          <h1 className="text-2xl font-semibold text-slate-900">GDPR Status</h1>
          <p className="mt-2 text-sm text-slate-600">
            Internal checklist page for compliance workstreams. This page is informational and should not display customer data.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {sections.map((section) => (
            <SectionCard key={section.id} section={section} />
          ))}
        </div>
      </div>
    </div>
  );
}
