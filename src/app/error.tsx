'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 text-center"><h1 className="text-3xl font-semibold">Dinodia V2 is unavailable</h1><p className="mt-3 text-[var(--muted)]">Please retry when the service is ready.</p><button className="mx-auto mt-8 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white" onClick={reset}>Try again</button></main>;
}
