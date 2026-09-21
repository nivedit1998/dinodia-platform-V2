// Architecture: App Router surface src/app/not-found.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import Image from 'next/image';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <div className="mb-6 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow">
            <Image
              src="/brand/logo-mark.png"
              alt="Dinodia logo"
              width={56}
              height={56}
              priority
            />
          </div>
        </div>
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          We couldn’t find the page you were looking for. Head back to the
          dashboard to continue.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/tenant/dashboard"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-700"
          >
            Tenant dashboard
          </Link>
          <Link
            href="/admin/settings"
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50"
          >
            Admin settings
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50"
          >
            Login
          </Link>
        </div>
      </div>
    </div>
  );
}
