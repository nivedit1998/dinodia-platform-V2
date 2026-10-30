"use client";

import { FormEvent, useEffect, useState } from "react";

// This page only finishes the links in Dinodia emails when the app did not open them (a computer, or a phone
// without the app). Sign-in and sign-up live in the app. Keep every state short, with one clear next step.
type LinkState = { kind: "reset"; challengeId: string; token: string } | null;
type Outcome = { tone: "working" | "done" | "problem"; title: string; detail: string; opensApp: boolean };

const OPEN_APP_URL = "dinodia-v2://open";

export default function CustomerAuthCompletionPage() {
  const [link, setLink] = useState<LinkState>(null);
  const [outcome, setOutcome] = useState<Outcome>({ tone: "working", title: "One moment", detail: "Opening your Dinodia link…", opensApp: false });
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const verifyToken = fragment.get("verify-email");
    const resetToken = fragment.get("reset-password");
    const challengeId = fragment.get("challenge");
    const invitationId = fragment.get("invitation");
    window.history.replaceState(null, document.title, window.location.pathname);
    const invalid: Outcome = { tone: "problem", title: "This link isn't valid", detail: "Open the Dinodia app and ask for a new one.", opensApp: true };
    if (invitationId && fragment.size === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
      // A reminder only: opening it grants nothing. The invitation is accepted inside the app.
      setOutcome({ tone: "done", title: "You're invited", detail: "Open the Dinodia app and enter the email this was sent to.", opensApp: true });
      return;
    }
    if (!challengeId || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
      setOutcome(invalid);
      return;
    }
    if (verifyToken && /^[A-Za-z0-9_-]{40,64}$/.test(verifyToken)) {
      setBusy(true);
      void fetch("/api/v2/auth/email/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, token: verifyToken }), cache: "no-store",
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "");
        setOutcome({ tone: "done", title: "Email confirmed", detail: "Open the Dinodia app to continue.", opensApp: true });
      }).catch(() => setOutcome({ tone: "problem", title: "This link has expired", detail: "Open the Dinodia app and ask for a new one.", opensApp: true }))
        .finally(() => setBusy(false));
      return;
    }
    if (resetToken && /^[A-Za-z0-9_-]{40,64}$/.test(resetToken)) {
      setLink({ kind: "reset", challengeId, token: resetToken });
      setOutcome({ tone: "working", title: "Choose a new password", detail: "Use 12 or more characters.", opensApp: false });
      return;
    }
    setOutcome(invalid);
  }, []);

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!link || busy) return;
    if (Array.from(password).length < 12) {
      setOutcome({ tone: "working", title: "Choose a new password", detail: "Use 12 or more characters.", opensApp: false });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v2/auth/password/reset", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: link.challengeId, token: link.token, password }), cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "");
      setPassword(""); setLink(null);
      setOutcome({ tone: "done", title: "Password changed", detail: "Open the Dinodia app and sign in.", opensApp: true });
    } catch {
      setOutcome({ tone: "problem", title: "This link has expired", detail: "Open the Dinodia app and ask for a new one.", opensApp: true });
      setLink(null);
    } finally { setBusy(false); }
  }

  const accent = outcome.tone === "problem" ? "text-red-600" : outcome.tone === "done" ? "text-green-600" : "";
  return <main className="mx-auto flex min-h-screen max-w-md items-center px-5 py-12">
    <section className="w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Dinodia Smart Living</p>
      <h1 className={`mt-5 text-2xl font-semibold ${accent}`}>{outcome.title}</h1>
      <p className="mt-2 text-base text-[var(--muted)]" role="status" aria-live="polite">{outcome.detail}</p>
      {link?.kind === "reset" && <form className="mt-6 grid gap-3 text-left" onSubmit={submitReset}>
        <label className="grid gap-2 text-sm font-medium">New password
          <span className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-4">
            <input autoComplete="new-password" type={showPassword ? "text" : "password"} minLength={12} maxLength={1024} value={password}
              onChange={(event) => setPassword(event.target.value)} required className="min-w-0 flex-1 bg-transparent py-3 outline-none" />
            <button type="button" onClick={() => setShowPassword((value) => !value)} className="text-sm text-[var(--muted)]" aria-pressed={showPassword}>{showPassword ? "Hide" : "Show"}</button>
          </span>
        </label>
        <button disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save password"}</button>
      </form>}
      {outcome.opensApp && !busy && <a href={OPEN_APP_URL} className="mt-6 block rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white">Open the Dinodia app</a>}
      {busy && !link && <p className="mt-4 text-sm text-[var(--muted)]">Please keep this page open.</p>}
    </section>
  </main>;
}
