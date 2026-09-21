// Architecture: App Router surface src/app/privacy/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import Link from 'next/link';
import { PRIVACY_NOTICE_LAST_UPDATED, PRIVACY_NOTICE_VERSION } from '@/lib/policyVersions';

export const dynamic = 'force-static';

export default function PrivacyNoticePage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <h1 className="text-3xl font-semibold text-slate-900">Privacy Notice</h1>
        <p className="mt-2 text-sm text-slate-600">
          Version: <span className="font-semibold text-slate-900">{PRIVACY_NOTICE_VERSION}</span> • Last updated:{' '}
          <span className="font-semibold text-slate-900">{PRIVACY_NOTICE_LAST_UPDATED}</span>
        </p>

        <p className="mt-6 text-sm text-slate-700">
          This Privacy Notice explains how Dinodia Smart Living processes personal data when providing the Dinodia
          platform to homeowners and tenants.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">1) What data we collect</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>Account data (username, email, password hash, device trust identifiers).</li>
          <li>Home data (address details used during homeowner onboarding and account setup).</li>
          <li>Tenant access data (access rules/areas needed to operate the service).</li>
          <li>Smart-home operational data (device/entity identifiers, automation configuration, hub token state).</li>
          <li>Security and audit data (support access approvals and related audit trail events).</li>
          <li>Logs and diagnostics (minimised; sensitive fields redacted or hashed where appropriate).</li>
        </ul>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">2) Why we collect it</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>To provide the smart-home service (authentication, device onboarding, and ongoing operation).</li>
          <li>To secure accounts and prevent abuse.</li>
          <li>To provide customer support when requested.</li>
          <li>To maintain an audit trail for accountability and security.</li>
        </ul>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">3) Lawful bases</h2>
        <p className="mt-2 text-sm text-slate-700">
          We typically rely on contract (to deliver the service), legitimate interests (security and reliability), and
          consent for any optional non-essential processing.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">4) Sharing and processors</h2>
        <p className="mt-2 text-sm text-slate-700">
          We use service providers to host and operate the platform (e.g. hosting/CDN, database, email delivery). We
          restrict access and use least privilege where possible.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">5) Retention</h2>
        <p className="mt-2 text-sm text-slate-700">
          We keep personal data only as long as needed for the purposes described above, and we maintain a retention
          schedule internally. (Retention details may be updated over time.)
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">6) Your rights</h2>
        <p className="mt-2 text-sm text-slate-700">
          You may have rights to access, correct, delete, or restrict use of your personal data. Contact us to exercise
          your rights.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">7) Contact</h2>
        <p className="mt-2 text-sm text-slate-700">
          For privacy questions, contact: <span className="font-semibold">privacy@dinodiasmartliving.com</span>
        </p>

        <div className="mt-10 flex flex-wrap gap-3 text-sm">
          <Link href="/terms" className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700">
            View Terms
          </Link>
          <Link href="/login" className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700">
            Back to login
          </Link>
        </div>
      </div>
    </main>
  );
}
