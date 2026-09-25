"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function CompanyBootstrapPage() {
  const router = useRouter();
  const [invitation, setInvitation] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The invitation is delivered in the fragment, so it is not sent to the
    // server in a request URL. Keep it in component memory only.
    const value = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invitation") || "";
    setInvitation(value);
    window.history.replaceState(null, "", "/company/bootstrap");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/company/auth/bootstrap/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitation, username, password }), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The invitation is invalid or expired");
      setInvitation(""); setPassword(""); router.replace("/company/login" as never);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The invitation could not be completed"); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-16"><form onSubmit={submit} className="w-full rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow)] sm:p-12"><p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Dinodia Smart Living</p><h1 className="mt-4 text-3xl font-semibold tracking-tight">Create your Company Portal account</h1><p className="mt-3 leading-7 text-[var(--muted)]">This one-use invitation is bound to the verified work mailbox that received it. Choose your own credentials; no reusable bootstrap password is provided.</p><label className="mt-8 block text-sm font-semibold" htmlFor="username">Username</label><input id="username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><label className="mt-5 block text-sm font-semibold" htmlFor="password">Password</label><input id="password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error}</p><button disabled={busy || invitation.length < 32} className="mt-4 w-full rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Creating account…" : "Create account"}</button></form></main>;
}
