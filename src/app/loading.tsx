// Architecture: App Router surface src/app/loading.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import Image from 'next/image';

export default function AppLoading() {
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
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
        <p className="text-lg font-semibold">Loading Dinodia</p>
        <p className="mt-2 text-sm text-slate-600">
          Preparing your smart home dashboard…
        </p>
        <div className="mt-6 h-10 w-10 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-600" />
      </div>
    </div>
  );
}
