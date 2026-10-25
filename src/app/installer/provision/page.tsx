"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import QRCode from "qrcode";

type Workflow = { id: string; publicReference: string; kind: string; state: string; certifiedSerialNumber: string | null; reason: string | null };

export default function ProvisionPage() {
  const params = useSearchParams();
  const [workflowId, setWorkflowId] = useState(params.get("workflowId") || "");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [pairingCode, setPairingCode] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [claimQr, setClaimQr] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    fetch("/api/installer/workflows", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Assigned workflows could not be loaded");
        if (active) {
          const loaded = Array.isArray(body.workflows) ? body.workflows as Workflow[] : [];
          setWorkflows(loaded);
          if (!loaded.some((workflow) => workflow.id === workflowId)) setWorkflowId("");
        }
      })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Assigned workflows could not be loaded"); })
      .finally(() => { if (active) setLoadingWorkflows(false); });
    return () => { active = false; setPairingCode(""); };
  }, [workflowId]);

  useEffect(() => {
    const clearWhenHidden = () => { if (document.visibilityState !== "visible") { setPairingCode(""); setClaimQr(""); setResult("The one-time Home QR was cleared because the page left the foreground. If it was not scanned, use the authenticated claim-recovery flow; do not repeat pairing."); } };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => document.removeEventListener("visibilitychange", clearWhenHidden);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    try {
      const response = await fetch("/api/installer/hubs/provision", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current }, body: JSON.stringify({ workflowId, pairingCode }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Provisioning could not be approved");
      if (typeof body.homeClaimPresentation === "string") {
        const dataUrl = await QRCode.toDataURL(body.homeClaimPresentation, { errorCorrectionLevel: "H", margin: 2, width: 280 });
        if (document.visibilityState !== "visible") { setClaimQr(""); setResult("The one-time Home QR was not displayed because this page left the foreground. Use the authenticated claim-recovery flow; do not repeat pairing."); setPairingCode(""); return; }
        setClaimQr(dataUrl);
        setResult(`Provisioning approved for serial ${body.serialNumber}. The hub pairing is ${body.state}. Show this one-time customer Home claim QR to the signed-in homeowner now. It is not the installer pairing QR.`);
      } else {
        setClaimQr("");
        setResult(`Provisioning approved for serial ${body.serialNumber}. The hub pairing is ${body.state}. This was a replay, so the one-time Home QR is not available again here. Use the authenticated claim-recovery flow; do not repeat pairing.`);
      }
      setPairingCode("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Provisioning could not be approved"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12"><p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Assigned installation</p><h1 className="mt-4 text-4xl font-semibold tracking-tight">Approve hub provisioning</h1><p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Select an installation assigned to you, then enter the pairing code shown by the locked hub setup page or scan its QR value. The Portal never receives a reusable hub credential. The setup QR is only for installer pairing; after first-time approval, this page separately displays the one-time customer Home claim QR.</p><form onSubmit={submit} className="mt-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><label className="block text-sm font-semibold" htmlFor="workflow">Assigned installation</label><select id="workflow" required value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); idempotencyKey.current = crypto.randomUUID(); setClaimQr(""); setResult(""); setError(""); }} disabled={loadingWorkflows} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="">{loadingWorkflows ? "Loading assigned installations…" : "Select an assigned installation"}</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.publicReference} — {workflow.kind}{workflow.certifiedSerialNumber ? ` — ${workflow.certifiedSerialNumber}` : ""}</option>)}</select><label className="mt-5 block text-sm font-semibold" htmlFor="pairing-code">Pairing code or QR value</label><input id="pairing-code" required autoComplete="one-time-code" inputMode="text" value={pairingCode} onChange={(e) => setPairingCode(e.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error || result}</p><button disabled={busy || loadingWorkflows || workflows.length === 0} className="mt-4 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Checking…" : "Approve provisioning"}</button></form>{claimQr && <section className="mt-8 flex flex-wrap items-center gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5" aria-label="One-time customer Home claim QR"><Image src={claimQr} alt="One-time customer Home claim QR" width={280} height={280} unoptimized className="rounded-lg bg-white p-2"/><div className="max-w-md text-sm"><h2 className="font-semibold">Customer Home claim QR</h2><p className="mt-2">Have the homeowner scan this from the signed-in Dinodia app and finish the guided claim. This QR is not the installer pairing/setup QR. It is shown only for the initial successful approval and is not recoverable from a replay. Keep this page private; the QR is cleared when the page is hidden or the installation selection changes.</p></div></section>}</main>;
}
