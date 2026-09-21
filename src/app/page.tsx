export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-6 py-16">
      <section className="w-full rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow)] sm:p-12">
        <div className="mb-10 flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-[var(--accent)]" aria-hidden="true" />
          <span className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Dinodia V2</span>
        </div>
        <p className="mb-3 text-sm font-medium text-[var(--accent)]">Native foundation</p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">A clean starting point for the Dinodia home platform.</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">The native database baseline is connected to this Preview surface. Product journeys are introduced deliberately in their numbered stages.</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <a className="rounded-2xl bg-[var(--accent)] px-5 py-4 text-center font-semibold text-white transition hover:opacity-90" href="/api/health">Check service health</a>
          <a className="rounded-2xl border border-[var(--border)] px-5 py-4 text-center font-semibold transition hover:bg-[var(--surface-2)]" href="/api/readiness">Check database readiness</a>
        </div>
      </section>
    </main>
  );
}
