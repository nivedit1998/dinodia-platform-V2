"use client";

import { FormEvent, useEffect, useState } from "react";

type LinkState = { kind: "verify" | "reset"; challengeId: string; token: string } | { kind: "invitation"; invitationId: string } | null;

export default function CustomerAuthCompletionPage() {
  const [link, setLink] = useState<LinkState>(null);
  const [state, setState] = useState("Opening your secure Dinodia link…");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const verifyToken = fragment.get("verify-email");
    const resetToken = fragment.get("reset-password");
    const challengeId = fragment.get("challenge");
    const invitationId = fragment.get("invitation");
    window.history.replaceState(null, document.title, window.location.pathname);
    if (invitationId && fragment.size === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
      setLink({ kind: "invitation", invitationId });
      setState("This is a sign-in reminder, not an access code. Open Dinodia Smart Living V2 and sign in or register with the invited email. Review the current invitation under Pending and explicitly accept it there. No Home access is granted by opening this link.");
      return;
    }
    if (!challengeId || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
      setState("This link is incomplete or invalid. Return to Dinodia and request a new one.");
      return;
    }
    if (verifyToken && /^[A-Za-z0-9_-]{40,64}$/.test(verifyToken)) {
      setLink({ kind: "verify", challengeId, token: verifyToken });
      setBusy(true);
      void fetch("/api/v2/auth/email/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, token: verifyToken }), cache: "no-store",
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "This verification link could not be used.");
        setState("Email verified. Return to Dinodia Smart Living and sign in.");
        setLink(null);
      }).catch((error: unknown) => setState(error instanceof Error ? error.message : "Verification could not be completed. Request a new link."))
        .finally(() => setBusy(false));
      return;
    }
    if (resetToken && /^[A-Za-z0-9_-]{40,64}$/.test(resetToken)) {
      setLink({ kind: "reset", challengeId, token: resetToken });
      setState("Choose a new password. Your other signed-in sessions will be revoked.");
      return;
    }
    setState("This link is incomplete or invalid. Return to Dinodia and request a new one.");
  }, []);

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!link || link.kind !== "reset" || busy) return;
    if (password.length < 12 || password !== confirmation) {
      setState(password.length < 12 ? "Use at least 12 characters for your new password." : "The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v2/auth/password/reset", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: link.challengeId, token: link.token, password }), cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "Password reset could not be completed.");
      setPassword(""); setConfirmation(""); setLink(null);
      setState("Your password has been changed. Sign in again in the Dinodia Smart Living app.");
    } catch (error) {
      setState(error instanceof Error ? error.message : "Password reset could not be completed. Request a new link.");
    } finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-12">
    <section className="w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-7 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Dinodia Smart Living</p>
      <h1 className="mt-3 text-2xl font-semibold">Account verification</h1>
      <p className="mt-4 text-sm leading-6 text-[var(--muted)]" role="status" aria-live="polite">{state}</p>
      {link?.kind === "reset" && <form className="mt-6 grid gap-4" onSubmit={submitReset}>
        <label className="grid gap-2 text-sm font-medium">New password
          <input autoComplete="new-password" type="password" minLength={12} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} required className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" />
        </label>
        <label className="grid gap-2 text-sm font-medium">Confirm new password
          <input autoComplete="new-password" type="password" minLength={12} maxLength={1024} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" />
        </label>
        <button disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save new password"}</button>
      </form>}
      {busy && <p className="mt-4 text-xs text-[var(--muted)]">Please keep this page open while Dinodia confirms the request.</p>}
    </section>
  </main>;
}
