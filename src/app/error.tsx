// Architecture: App Router surface src/app/error.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app/error] unhandled error boundary', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-16 text-slate-900">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-slate-600">
          Please refresh and try again.
        </p>
        <div>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
