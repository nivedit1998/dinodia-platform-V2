"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Workflow = { id: string; publicReference: string; kind: string; state: string; certifiedSerialNumber: string | null; reason: string | null };

export default function ProvisionPage() {
  const params = useSearchParams();
  const [workflowId, setWorkflowId] = useState(params.get("workflowId") || "");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [attemptId, setAttemptId] = useState("");
  const [presentation, setPresentation] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    return () => { active = false; };
  }, [workflowId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    try {
      const response = await fetch("/api/installer/hubs/provision", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current }, body: JSON.stringify({ workflowId, attemptId, presentation }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Provisioning could not be approved");
      setResult(`Provisioning approved for serial ${body.serialNumber}. Attempt ${body.attemptId} is ${body.state}.` + (body.homeClaimPresentation ? " The secure Home QR reference is ready for the controlled claim flow." : ""));
      setPresentation("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Provisioning could not be approved"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12"><p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Assigned installation</p><h1 className="mt-4 text-4xl font-semibold tracking-tight">Approve hub provisioning</h1><p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Select an installation assigned to you, then enter the attempt-bound presentation from the locked hub setup page. The Portal never receives a reusable hub credential.</p><form onSubmit={submit} className="mt-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><label className="block text-sm font-semibold" htmlFor="workflow">Assigned installation</label><select id="workflow" required value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); idempotencyKey.current = crypto.randomUUID(); }} disabled={loadingWorkflows} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="">{loadingWorkflows ? "Loading assigned installations…" : "Select an assigned installation"}</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.publicReference} — {workflow.kind}{workflow.certifiedSerialNumber ? ` — ${workflow.certifiedSerialNumber}` : ""}</option>)}</select><label className="mt-5 block text-sm font-semibold" htmlFor="attempt">Hub attempt ID</label><input id="attempt" required autoComplete="off" value={attemptId} onChange={(e) => setAttemptId(e.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><label className="mt-5 block text-sm font-semibold" htmlFor="presentation">One-use provisioning presentation</label><input id="presentation" required autoComplete="off" value={presentation} onChange={(e) => setPresentation(e.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error || result}</p><button disabled={busy || loadingWorkflows || workflows.length === 0} className="mt-4 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Checking…" : "Approve provisioning"}</button></form></main>;
}
