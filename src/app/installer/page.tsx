"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Workflow = {
  id: string;
  publicReference: string;
  kind: string;
  state: string;
  homeId: string | null;
  hubInstallationId: string | null;
  certifiedSerialNumber: string | null;
  reason: string | null;
  updatedAt: string;
  hubInstallation?: { baseUrl: string | null; cloudUrl: string | null } | null;
};

type Employee = { id: string; displayName: string; role: string };
type OperatorCredential = {
  version: number;
  state: string;
  issuedAt: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  activatedAt: string | null;
  graceUntil: string | null;
  revokedAt: string | null;
};

export default function InstallerPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [reservingCloudflare, setReservingCloudflare] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [employeeRole, setEmployeeRole] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [pairingCode, setPairingCode] = useState("");
  const [assignedEmployeeId, setAssignedEmployeeId] = useState("");
  const [workReason, setWorkReason] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [operatorCredentials, setOperatorCredentials] = useState<Record<string, OperatorCredential[]>>({});
  const [operatorStatusMessages, setOperatorStatusMessages] = useState<Record<string, string>>({});
  const [operatorAction, setOperatorAction] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/installer/workflows", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Portal session required"); return body; })
      .then((body) => { setWorkflows(body.workflows || []); setEmployeeRole(body.employee?.role || ""); setEmployees(body.employees || []); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Portal session required"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const clearWhenHidden = () => { if (document.visibilityState !== "visible") setPairingCode(""); };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => document.removeEventListener("visibilitychange", clearWhenHidden);
  }, []);

  async function openHub(work: Workflow) {
    if (!work.homeId || !work.hubInstallationId) return;
    setOpening(work.id); setActionMessage("");
    const cloudUrl = String(work.hubInstallation?.cloudUrl || "").replace(/\/$/, "");
    const baseUrl = String(work.hubInstallation?.baseUrl || "").replace(/\/$/, "");
    const operatorOriginUrl = cloudUrl || baseUrl;
    const operatorUrl = operatorOriginUrl ? `${operatorOriginUrl}/support-access` : "";
    if (!operatorUrl) { setActionMessage("The hub has no verified secure endpoint yet"); setOpening(null); return; }
    const operatorOrigin = new URL(operatorUrl).origin;
    let popup: Window | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;
    try {
      const setupAttemptId = await new Promise<string>((resolve, reject) => {
        const timeout = window.setTimeout(() => { if (messageHandler) window.removeEventListener("message", messageHandler); reject(new Error("The locked Dinodia OS browser did not register in time.")); }, 30_000);
        messageHandler = (event: MessageEvent) => {
          if (event.source !== popup || event.origin !== operatorOrigin || event.data?.type !== "dinodia-operator-attempt" || typeof event.data.setupAttemptId !== "string") return;
          window.clearTimeout(timeout); window.removeEventListener("message", messageHandler!); resolve(event.data.setupAttemptId);
        };
        window.addEventListener("message", messageHandler);
        popup = window.open(operatorUrl, "dinodia-os-operator", "popup,width=860,height=760");
        if (!popup) { window.clearTimeout(timeout); window.removeEventListener("message", messageHandler); reject(new Error("The browser blocked the secure Dinodia OS window. Allow pop-ups and try again.")); }
      });
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(work.homeId)}/os-access/launch`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId: work.id, setupAttemptId }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The secure Dinodia OS session could not be started");
      if (!popup) throw new Error("The secure Dinodia OS window is unavailable");
      const deliver = () => { try { popup?.postMessage({ type: "dinodia-operator-handoff", handoffId: body.handoffId }, operatorOrigin); } catch {} };
      deliver();
      const retry = window.setInterval(() => { if (popup?.closed) { window.clearInterval(retry); return; } deliver(); }, 500);
      window.setTimeout(() => window.clearInterval(retry), 15000);
      setActionMessage(`${cloudUrl ? "The secure" : "The private-LAN"} Dinodia OS window opened. The handoff is one-use and expires in 60 seconds.`);
    } catch (caught) { (popup as Window | null)?.close(); setActionMessage(caught instanceof Error ? caught.message : "The secure Dinodia OS session could not be started"); }
    finally { setOpening(null); }
  }

  async function reserveCloudflare(work: Workflow) {
    if (!work.homeId || !work.hubInstallationId) return;
    setReservingCloudflare(work.id); setActionMessage("");
    try {
      const response = await fetch(`/api/installer/hubs/${encodeURIComponent(work.hubInstallationId)}/cloudflare/reserve`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ workflowId: work.id, reason: "Reserve the installation-specific secure Dinodia OS endpoint" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The secure endpoint could not be reserved");
      const refreshed = await fetch("/api/installer/workflows", { credentials: "same-origin", cache: "no-store" });
      const refreshedBody = await refreshed.json().catch(() => ({}));
      if (!refreshed.ok) throw new Error(refreshedBody.error || "Assigned work could not be refreshed");
      setWorkflows(refreshedBody.workflows || []);
      setActionMessage("The installation-specific secure endpoint is reserved. Open the local Dinodia OS dashboard and complete its Cloudflare setup, then return here.");
    } catch (caught) {
      setActionMessage(caught instanceof Error ? caught.message : "The secure endpoint could not be reserved");
    } finally { setReservingCloudflare(null); }
  }

  async function assignWork(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAssigning(true); setActionMessage("");
    try {
      const response = await fetch("/api/installer/workflows", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ pairingCode, assignedEmployeeId, reason: workReason }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Installation work could not be assigned");
      setActionMessage("Installation work assigned from the persisted hub pairing."); setPairingCode(""); setWorkReason("");
      const refreshed = await fetch("/api/installer/workflows", { credentials: "same-origin", cache: "no-store" });
      const refreshedBody = await refreshed.json().catch(() => ({})); setWorkflows(refreshedBody.workflows || []);
    } catch (caught) { setActionMessage(caught instanceof Error ? caught.message : "Installation work could not be assigned"); }
    finally { setAssigning(false); }
  }

  async function refreshOperatorCredentials(work: Workflow) {
    if (!work.homeId) return;
    setOperatorAction(`status:${work.id}`);
    setOperatorStatusMessages((current) => ({ ...current, [work.id]: "Checking the durable hub credential state…" }));
    try {
      const query = new URLSearchParams({ workflowId: work.id });
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(work.homeId)}/os-access/status?${query}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Operator credential status is unavailable");
      const credentials = Array.isArray(body.credentials) ? body.credentials as OperatorCredential[] : [];
      setOperatorCredentials((current) => ({ ...current, [work.id]: credentials }));
      setOperatorStatusMessages((current) => ({ ...current, [work.id]: credentials.length ? "Credential status refreshed from the Platform record." : "No operator credential has been issued for this hub yet." }));
    } catch (caught) {
      setOperatorStatusMessages((current) => ({ ...current, [work.id]: caught instanceof Error ? caught.message : "Operator credential status is unavailable" }));
    } finally { setOperatorAction(null); }
  }

  async function rotateOperatorCredential(work: Workflow) {
    if (!work.homeId) return;
    setOperatorAction(`rotate:${work.id}`);
    setOperatorStatusMessages((current) => ({ ...current, [work.id]: "Submitting a protected rotation request…" }));
    try {
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(work.homeId)}/os-access/rotate`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ workflowId: work.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Operator credential rotation was not accepted");
      setOperatorStatusMessages((current) => ({ ...current, [work.id]: `Credential version ${body.version} is pending secure hub delivery. The credential itself is never shown in Company Portal.` }));
      await refreshOperatorCredentials(work);
    } catch (caught) {
      setOperatorStatusMessages((current) => ({ ...current, [work.id]: caught instanceof Error ? caught.message : "Operator credential rotation was not accepted" }));
    } finally { setOperatorAction(null); }
  }

  return <main className="mx-auto min-h-screen w-full max-w-5xl px-6 py-12">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Dinodia Smart Living</p><h1 className="mt-3 text-4xl font-semibold tracking-tight">Assigned work</h1><p className="mt-3 text-[var(--muted)]">Only work assigned to the signed-in employee appears here.</p></div><div className="flex gap-3"><a className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold" href="/installer/home-support">Support access</a><button className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold" onClick={async () => { await fetch("/api/company/auth/session", { method: "DELETE", credentials: "same-origin" }); router.replace("/company/login" as never); }}>Sign out</button></div></header>
    {error && <p role="alert" className="mt-8 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    {actionMessage && <p role="status" aria-live="polite" className="mt-6 rounded-xl border border-[var(--border)] p-4 text-sm">{actionMessage}</p>}
    {(employeeRole === "CXO" || employeeRole === "SENIOR_OPERATIONS_MANAGER") && <form onSubmit={assignWork} className="mt-8 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><h2 className="text-xl font-semibold">Create assigned installation work</h2><p className="mt-2 text-sm text-[var(--muted)]">Enter the pairing code shown by the locked Dinodia OS setup page or scan its QR value. Serial, identity, work type and later home/hub bindings are loaded from the server.</p><label className="mt-5 block text-sm font-semibold" htmlFor="pairing-code">Pairing code or QR value</label><input id="pairing-code" required autoComplete="one-time-code" inputMode="text" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><label className="mt-5 block text-sm font-semibold" htmlFor="assignee">Assign to</label><select id="assignee" required value={assignedEmployeeId} onChange={(event) => setAssignedEmployeeId(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="">Select an installation employee</option>{employees.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName} — {candidate.role}</option>)}</select><label className="mt-5 block text-sm font-semibold" htmlFor="work-reason">Reason</label><input id="work-reason" required maxLength={500} value={workReason} onChange={(event) => setWorkReason(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3" /><button disabled={assigning} className="mt-5 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{assigning ? "Assigning…" : "Assign installation work"}</button></form>}
    {loading ? <p className="mt-10 text-[var(--muted)]" aria-live="polite">Loading assigned work…</p> : <section className="mt-10 grid gap-4">{workflows.length === 0 ? <p className="rounded-2xl border border-[var(--border)] p-6 text-[var(--muted)]">No active work is assigned to this employee.</p> : workflows.map((work) => {
      const credentials = operatorCredentials[work.id] || [];
      const latestCredential = credentials[0];
      const rotationPending = latestCredential && ["PENDING", "DELIVERED", "ACKNOWLEDGED"].includes(latestCredential.state);
      const operatorBusy = operatorAction === `status:${work.id}` || operatorAction === `rotate:${work.id}`;
      return <article key={work.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{work.publicReference}</p><h2 className="mt-2 text-xl font-semibold">{work.kind}</h2><p className="mt-2 text-[var(--muted)]">{work.reason || "Installation or property work"}</p></div><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm font-semibold">{work.state}</span></div><div className="mt-5 flex flex-wrap gap-3"><a className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white" href={`/installer/provision?workflowId=${encodeURIComponent(work.id)}`}>Open provisioning</a>{work.hubInstallationId && work.homeId && !work.hubInstallation?.cloudUrl && <button type="button" onClick={() => reserveCloudflare(work)} disabled={reservingCloudflare === work.id} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:opacity-50">{reservingCloudflare === work.id ? "Reserving secure endpoint…" : "Reserve secure endpoint"}</button>}{work.hubInstallationId && work.homeId && !work.hubInstallation?.cloudUrl && work.hubInstallation?.baseUrl && <button type="button" onClick={() => openHub(work)} disabled={opening === work.id} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:opacity-50">{opening === work.id ? "Opening local OS…" : "Open local Dinodia OS"}</button>}{work.hubInstallationId && work.homeId && work.hubInstallation?.cloudUrl && <button type="button" onClick={() => openHub(work)} disabled={opening === work.id} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:opacity-50">{opening === work.id ? "Opening secure OS…" : "Open secure Dinodia OS"}</button>}{work.homeId && <a className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold" href={`/installer/home-support?homeId=${encodeURIComponent(work.homeId)}`}>Open home support</a>}</div>
        {work.homeId && work.hubInstallationId && <section className="mt-6 rounded-xl border border-[var(--border)] p-4" aria-label={`Operator credential status for ${work.publicReference}`}><h3 className="font-semibold">Operator credential</h3><p className="mt-1 text-sm text-[var(--muted)]">Only version and lifecycle state are shown here. The credential is delivered directly to the paired hub and is never displayed in the Portal.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" onClick={() => refreshOperatorCredentials(work)} disabled={operatorBusy} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50">{operatorAction === `status:${work.id}` ? "Refreshing…" : "Refresh status"}</button>{(employeeRole === "CXO" || employeeRole === "SENIOR_OPERATIONS_MANAGER") && <button type="button" onClick={() => rotateOperatorCredential(work)} disabled={operatorBusy || Boolean(rotationPending)} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{operatorAction === `rotate:${work.id}` ? "Requesting…" : latestCredential ? "Rotate operator credential" : "Issue operator credential"}</button>}</div>{credentials.length > 0 && <ol className="mt-4 grid gap-2">{credentials.map((credential) => <li key={credential.version} className="rounded-lg bg-[var(--surface-2)] p-3 text-sm"><span className="font-semibold">Version {credential.version}: {credential.state}</span><span className="ml-2 text-[var(--muted)]">{credential.activatedAt ? `Active since ${new Date(credential.activatedAt).toLocaleString()}` : credential.acknowledgedAt ? `Acknowledged ${new Date(credential.acknowledgedAt).toLocaleString()}` : credential.deliveredAt ? `Delivered ${new Date(credential.deliveredAt).toLocaleString()}` : `Issued ${new Date(credential.issuedAt).toLocaleString()}`}</span></li>)}</ol>}{operatorStatusMessages[work.id] && <p className="mt-3 text-sm" aria-live="polite" role="status">{operatorStatusMessages[work.id]}</p>}</section>}
      </article>;
    })}</section>}
  </main>;
}
