"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";

type Preview = {
  eligible: boolean;
  reasonCode: string | null;
  hubInstallationId: string | null;
  claimGeneration: number | null;
  resolverGeneration: number | null;
};

async function responseBody(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request was not accepted");
  return body;
}

export default function ClaimRecoveryPage() {
  const [serialNumber, setSerialNumber] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [claimQr, setClaimQr] = useState("");

  useEffect(() => {
    const clearOnHide = () => {
      if (document.visibilityState !== "visible") {
        setClaimQr(""); setPreview(null); setConfirmed(false); setMessage(""); setSerialNumber("");
      }
    };
    document.addEventListener("visibilitychange", clearOnHide);
    return () => document.removeEventListener("visibilitychange", clearOnHide);
  }, []);

  async function checkEligibility(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage(""); setClaimQr(""); setPreview(null); setConfirmed(false);
    try {
      const query = new URLSearchParams({ serialNumber: serialNumber.trim() });
      const body = await responseBody(await fetch(`/api/installer/hubs/claim-recovery?${query}`, { credentials: "same-origin", cache: "no-store" }));
      setPreview({ eligible: body.eligible === true, reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : null,
        hubInstallationId: typeof body.hubInstallationId === "string" ? body.hubInstallationId : null,
        claimGeneration: Number.isSafeInteger(body.claimGeneration) ? body.claimGeneration : null,
        resolverGeneration: Number.isSafeInteger(body.resolverGeneration) ? body.resolverGeneration : null });
      setMessage(body.eligible === true ? "An unclaimed initial-owner QR is available for this active hub. No state has changed." : "This hub is not eligible for initial-owner QR recovery. No state has changed.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Eligibility could not be checked"); }
    finally { setBusy(false); }
  }

  async function issueReplacement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview?.eligible || !preview.hubInstallationId || preview.resolverGeneration === null || !confirmed) return;
    setBusy(true); setError(""); setMessage(""); setClaimQr("");
    let replacementReferenceReturned = false;
    try {
      const response = await fetch(`/api/installer/hubs/${encodeURIComponent(preview.hubInstallationId)}/claim-resolver/replace`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Owner QR recovery after installer pairing QR was scanned in customer app", expectedResolverGeneration: preview.resolverGeneration, confirmed: true }),
      });
      const body = await responseBody(response);
      if (typeof body.reference !== "string" || !/^DNO-HOME-[A-Za-z0-9_-]{32,}$/.test(body.reference)) throw new Error("The server response did not contain a valid replacement QR reference");
      replacementReferenceReturned = true;
      const dataUrl = await QRCode.toDataURL(body.reference, { errorCorrectionLevel: "H", margin: 2, width: 300 });
      if (document.visibilityState !== "visible") {
        setClaimQr(""); setPreview(null); setConfirmed(false);
        setError("The replacement was issued, but the page was no longer in the foreground, so its QR was cleared. Refresh the read-only eligibility status before taking any further action.");
        return;
      }
      setClaimQr(dataUrl);
      setPreview(null); setConfirmed(false);
      setMessage(`Replacement permanent Home QR label issued at resolver generation ${body.generation}. It is shown only in this page and is not saved for replay. Scan it from the signed-in Dinodia app on the Home's trusted local network, complete the guided claim, and replace the old printed label.`);
    } catch {
      setError(replacementReferenceReturned
        ? "The replacement was issued, but its QR could not be displayed. Refresh the read-only eligibility status before taking any further action."
        : "The replacement request may have been applied even though its response was not confirmed. Do not retry automatically; refresh the read-only eligibility status before taking any further action.");
    } finally { setBusy(false); }
  }

  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
    <a href="/installer" className="text-sm font-semibold text-[var(--muted)]">← Company Portal</a>
    <p className="mt-8 text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Existing installation recovery</p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight">Replace the permanent Home QR label</h1>
    <p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Use this only when the first-run customer claim QR was lost or never shown and you are prepared to replace the printed permanent Home QR label. The QR on the Pi installer pairing/setup screen is not a customer Home claim and must not be scanned in the Dinodia app.</p>
    <form onSubmit={checkEligibility} className="mt-8 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <label htmlFor="hub-serial" className="block text-sm font-semibold">Existing hub serial number</label>
      <input id="hub-serial" required maxLength={120} autoComplete="off" value={serialNumber} onChange={(event) => { setSerialNumber(event.target.value); setPreview(null); setClaimQr(""); setConfirmed(false); }} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" />
      <button disabled={busy || !serialNumber.trim()} className="mt-4 rounded-xl border border-[var(--border)] px-5 py-3 font-semibold disabled:opacity-50">{busy && !preview ? "Checking…" : "Check claim eligibility (read-only)"}</button>
    </form>
    {preview && <section className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6" aria-label="Home claim recovery eligibility">
      <h2 className="text-xl font-semibold">{preview.eligible ? "Eligible for replacement" : "Not eligible for replacement"}</h2>
      <p className="mt-2 text-sm">Claim generation: {preview.claimGeneration ?? "Unavailable"}; resolver generation: {preview.resolverGeneration ?? "Unavailable"}.</p>
      {preview.reasonCode && <p className="mt-2 text-sm text-[var(--muted)]">Status: {preview.reasonCode}</p>}
      {preview.eligible && <form onSubmit={issueReplacement} className="mt-5 border-t border-[var(--border)] pt-5">
        <p className="text-sm leading-6"><strong>Before you continue:</strong> this rotates the shared Home resolver used by the existing permanent physical QR label and the initial-owner claim. The old label/code and outstanding claim challenges will stop working. You must replace or reprint that physical label; the new QR can be scanned from the signed-in Dinodia app while the phone is on the Home&apos;s trusted local network. This does not create another Home, change ownership, re-pair the hub, or alter the installed identity, tunnel, devices, or data. If the request response is lost, the outcome may be uncertain; refresh the read-only status before doing anything else.</p>
        <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />I understand the existing physical Home QR label and old claim code will be invalidated, I can replace/reprint the label, and I want to issue one replacement QR for this existing Home.</label>
        <button disabled={busy || !confirmed} className="mt-5 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Issuing replacement…" : "Replace Home QR label"}</button>
      </form>}
    </section>}
    {(message || error) && <p role={error ? "alert" : "status"} aria-live="polite" className={`mt-5 rounded-xl border p-4 text-sm ${error ? "border-red-200 text-red-800" : "border-[var(--border)]"}`}>{error || message}</p>}
    {claimQr && <section className="mt-6 flex flex-wrap items-center gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="Replacement permanent Home QR label"><Image src={claimQr} alt="Replacement permanent Home QR label" width={300} height={300} unoptimized className="rounded-lg bg-white p-2"/><div className="max-w-md text-sm"><h2 className="font-semibold">Replacement permanent Home QR label</h2><p className="mt-2">Keep this page private. Scan it from the signed-in Dinodia app while the iPhone is on the Home&apos;s trusted local network, then replace the old printed label. It is not the installer pairing QR. The QR is held only in page memory and cleared when the page is hidden. Do not copy or send it.</p></div></section>}
  </main>;
}
