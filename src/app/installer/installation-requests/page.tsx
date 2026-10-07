import InstallationRequestsClient from './InstallationRequestsClient';

export const dynamic = 'force-dynamic';

export default function InstallationRequestsPage() {
  return <main className="mx-auto min-h-screen w-full max-w-5xl px-6 py-12">
    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Company Portal</p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight">Permanent installation requests</h1>
    <p className="mt-3 max-w-3xl leading-7 text-[var(--muted)]">This staff queue is separate from tenant self-commissioning. Starting work assigns one employee and closes customer cancellation. Radio commissioning remains unavailable unless this hub’s protocol and supported-device catalogue are approved.</p>
    <InstallationRequestsClient />
  </main>;
}
