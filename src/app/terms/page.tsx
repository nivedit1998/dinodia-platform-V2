// Architecture: App Router surface src/app/terms/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import Link from 'next/link';
import { TERMS_LAST_UPDATED, TERMS_VERSION } from '@/lib/policyVersions';

export const dynamic = 'force-static';

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <h1 className="text-3xl font-semibold text-slate-900">Terms and Conditions</h1>
        <p className="mt-2 text-sm text-slate-600">
          Version: <span className="font-semibold text-slate-900">{TERMS_VERSION}</span> • Last updated:{' '}
          <span className="font-semibold text-slate-900">{TERMS_LAST_UPDATED}</span>
        </p>

        <p className="mt-6 text-sm text-slate-700">
          These Terms describe how Dinodia Smart Living provides access to the Dinodia platform for homeowners and
          tenants. This page is intended as a published reference and may be updated over time.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">1) Service</h2>
        <p className="mt-2 text-sm text-slate-700">
          Dinodia provides a smart-home platform that allows authorized users to view and control devices according to
          their access level.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">2) Accounts and security</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>Keep your credentials confidential and use strong passwords.</li>
          <li>Do not attempt to access data or devices you are not authorized to access.</li>
          <li>We may suspend access to protect users and the platform.</li>
        </ul>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">3) Support access</h2>
        <p className="mt-2 text-sm text-slate-700">
          Installer/support access is designed to be explicitly approved, time-limited, and revocable, with an audit
          trail for accountability.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">4) Privacy</h2>
        <p className="mt-2 text-sm text-slate-700">
          See the <Link href="/privacy" className="font-semibold underline underline-offset-2">Privacy Notice</Link> for how we handle personal data.
        </p>

        <h2 className="mt-8 text-lg font-semibold text-slate-900">5) Contact</h2>
        <p className="mt-2 text-sm text-slate-700">
          Support: <span className="font-semibold">support@dinodiasmartliving.com</span>
        </p>

        <div className="mt-10 flex flex-wrap gap-3 text-sm">
          <Link href="/privacy" className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700">
            View Privacy Notice
          </Link>
          <Link href="/login" className="font-semibold text-slate-900 underline underline-offset-2 hover:text-slate-700">
            Back to login
          </Link>
        </div>
      </div>
    </main>
  );
}
