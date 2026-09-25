"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function CompanyLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/company/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Company Portal sign-in failed");
      router.replace("/installer" as never);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Company Portal sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-16">
      <form onSubmit={submit} className="w-full rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow)] sm:p-12">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Dinodia Smart Living</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">Company Portal</h1>
        <p className="mt-3 leading-7 text-[var(--muted)]">Sign in with your employee account. Customer accounts cannot enter this portal.</p>
        <label className="mt-8 block text-sm font-semibold" htmlFor="email">Work email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" />
        <label className="mt-5 block text-sm font-semibold" htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" />
        <p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error}</p>
        <button disabled={busy} className="mt-4 w-full rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
