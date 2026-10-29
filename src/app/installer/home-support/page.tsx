"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";

type Ticket = {
  id: string;
  publicReference: string;
  category: string;
  status: string;
  homeId: string;
  description: string;
  accessRequests: { id: string; status: string; requestedScope: string; createdAt: string }[];
};

type ExceptionalPreview = {
  homeId: string;
  managementRevision: number;
  eligible: boolean;
  actionAvailable: boolean;
  blockers: string[];
  home: null | {
    lifecycle: string;
    installationStatus: string;
    retainedAddress: string | null;
    activeAreaCount: number;
    permanentDevicesPreserved: number;
    privateDevicesRemoved: number;
    floorplanRegeneratedForSuccessor: boolean;
    inProgressInstallationWorkPreserved: number;
  };
  currentOwner: null | { membershipId: string; displayName: string; email: string };
  removedManagers: { membershipId: string; displayName: string; email: string }[];
  notificationRecipients: { membershipId: string; role: string; displayName: string; verifiedEmail: string }[];
  activeTenantSuccessorRejected: boolean;
  currentOwnerSuccessorRejected: boolean;
  cleanupEffects: { membershipId: string; role: string; finalRelationshipWouldBeRemoved: boolean }[];
  preserved: { activeTenantMemberships: number; canonicalAreas: number; permanentDevices: number; floorplanAndPresentation: boolean; hubAndTunnel: boolean; inProgressInstallationWork: number };
  activeCase: null | { caseId: string; status: string; revision: number; transferReference: string | null };
};

type ExceptionalClaim = { caseId: string; revision: number; transferReference: string };

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error
      : typeof body?.error?.message === "string" ? body.error.message : "The request could not be completed.";
    throw new Error(message);
  }
  return body;
}

function claimPayloadKey(payload: Record<string, unknown>) {
  return JSON.stringify(payload);
}

export default function HomeSupportPage() {
  const params = useSearchParams();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketId, setTicketId] = useState("");
  const [scope, setScope] = useState("PROPERTY_SCOPE");
  const [result, setResult] = useState("");
  const [issuedCode, setIssuedCode] = useState("");
  const [error, setError] = useState("");
  const [employeeRole, setEmployeeRole] = useState("");
  const [homeId, setHomeId] = useState("");
  const [proposedEmail, setProposedEmail] = useState("");
  const [reason, setReason] = useState("");
  const [verificationMethod, setVerificationMethod] = useState("");
  const [verificationReference, setVerificationReference] = useState("");
  const [staffAttestation, setStaffAttestation] = useState("");
  const [exceptionalPreview, setExceptionalPreview] = useState<ExceptionalPreview | null>(null);
  const [exceptionalClaim, setExceptionalClaim] = useState<ExceptionalClaim | null>(null);
  const [claimQr, setClaimQr] = useState("");
  const [exceptionalBusy, setExceptionalBusy] = useState(false);
  const [exceptionalMessage, setExceptionalMessage] = useState("");
  const [exceptionalError, setExceptionalError] = useState("");
  const submitKeys = useRef(new Map<string, string>());
  const cancelKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/company/support/tickets", { credentials: "same-origin", cache: "no-store" })
      .then(readResponse)
      .then((body) => {
        if (cancelled) return;
        setEmployeeRole(typeof body.employeeRole === "string" ? body.employeeRole : "");
        setTickets(Array.isArray(body.tickets) ? body.tickets : []);
        const queryTicketId = params.get("ticketId");
        if (queryTicketId) setTicketId(queryTicketId);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Portal session required"); });
    return () => { cancelled = true; };
  }, [params]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        setResult(""); setIssuedCode(""); setExceptionalPreview(null);
        setExceptionalClaim(null); setClaimQr(""); setExceptionalMessage("");
        setProposedEmail(""); setReason(""); setVerificationMethod("");
        setVerificationReference(""); setStaffAttestation("");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  async function requestAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setResult("");
    const response = await fetch(`/api/v2/support/tickets/${encodeURIComponent(ticketId)}/access-requests`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedScope: scope }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body?.error?.message || body.error || "Access request failed"); else setResult(`Access request ${body.accessRequest.id} created and is waiting for customer approval.`);
  }

  async function issueCode(ticket: Ticket, requestId: string) {
    setError(""); setResult(""); setIssuedCode("");
    const supportWindow = window.open("about:blank", "dinodia-os-support", "popup,width=720,height=760");
    const response = await fetch(`/api/v2/support/tickets/${encodeURIComponent(ticket.id)}/access-requests/${encodeURIComponent(requestId)}/issue`, { method: "POST", credentials: "same-origin" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.oneUseCode !== "string" || !/^DNO-S-[A-Za-z0-9_-]{20,}$/.test(body.oneUseCode)) { supportWindow?.close(); setError(body?.error?.message || body.error || "The support code could not be issued safely"); }
    else {
      setIssuedCode(body.oneUseCode);
      setTickets((current) => current.map((item) => item.id !== ticket.id ? item : ({ ...item, accessRequests: item.accessRequests.map((request) => request.id === requestId ? { ...request, status: "ISSUED" } : request) })));
      const deliver = () => {
        try { supportWindow?.postMessage({ type: "dinodia-support-proof", ticketId: ticket.id }, new URL(String(body.supportUrl)).origin); } catch { /* popup may not be ready yet */ }
      };
      if (supportWindow) {
        supportWindow.location.href = String(body.supportUrl);
        supportWindow.addEventListener("load", deliver, { once: true });
        const retryTimer = window.setInterval(() => { if (supportWindow.closed) { window.clearInterval(retryTimer); return; } deliver(); }, 500);
        window.setTimeout(() => window.clearInterval(retryTimer), 15000);
      }
      setResult("The hub support page opened and received the encrypted employee authority automatically. Enter the one-time code shown below there. It is visible only in this Company Portal session.");
    }
  }

  function clearExceptionalResult() {
    setExceptionalPreview(null); setExceptionalClaim(null); setClaimQr("");
    setExceptionalMessage(""); setExceptionalError("");
  }

  async function showClaimQr(reference: string) {
    const dataUrl = await QRCode.toDataURL(reference, { errorCorrectionLevel: "H", margin: 2, width: 280 });
    setClaimQr(dataUrl);
  }

  async function previewExceptional(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setExceptionalBusy(true); setExceptionalError(""); setExceptionalMessage("");
    setExceptionalPreview(null); setExceptionalClaim(null); setClaimQr("");
    try {
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(homeId.trim())}/ownership-transfer/exceptional/preview`, {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposedIncomingEmail: proposedEmail.trim() }),
      });
      const preview = await readResponse(response) as ExceptionalPreview;
      setExceptionalPreview(preview);
      if (preview.activeCase?.transferReference) {
        const claim = { caseId: preview.activeCase.caseId, revision: preview.activeCase.revision, transferReference: preview.activeCase.transferReference };
        setExceptionalClaim(claim); await showClaimQr(claim.transferReference);
        setExceptionalMessage("An existing matching transfer claim is still available. This QR is the same claim, not a second transfer.");
      }
    } catch (reason) { setExceptionalError(reason instanceof Error ? reason.message : "The read-only preview failed."); }
    finally { setExceptionalBusy(false); }
  }

  async function submitExceptional(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!exceptionalPreview || !exceptionalPreview.eligible || !exceptionalPreview.actionAvailable) return;
    setExceptionalBusy(true); setExceptionalError(""); setExceptionalMessage(""); setExceptionalClaim(null); setClaimQr("");
    const payload = { proposedIncomingEmail: proposedEmail.trim(), expectedManagementRevision: exceptionalPreview.managementRevision,
      reason: reason.trim(), verificationMethod: verificationMethod.trim(), verificationReference: verificationReference.trim(), staffAttestation: staffAttestation.trim() };
    const signature = claimPayloadKey({ homeId: homeId.trim(), ...payload });
    let key = submitKeys.current.get(signature);
    if (!key) { key = `exceptional-transfer-${crypto.randomUUID()}`; submitKeys.current.set(signature, key); }
    try {
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(homeId.trim())}/ownership-transfer/exceptional`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload),
      });
      const body = await readResponse(response);
      if (typeof body.transferReference !== "string" || typeof body.caseId !== "string" || typeof body.revision !== "number") throw new Error("The server did not return the expected claim receipt.");
      const claim = { caseId: body.caseId, revision: body.revision, transferReference: body.transferReference };
      setExceptionalClaim(claim); await showClaimQr(claim.transferReference);
      setExceptionalMessage("The exceptional case and normal single-use transfer claim were created. Ownership has not changed. Give the QR only to the verified proposed recipient; the incoming person must complete the normal claim journey.");
    } catch (reason) { setExceptionalError(reason instanceof Error ? reason.message : "Submission failed. Retry without changing the request to reconcile the same operation."); }
    finally { setExceptionalBusy(false); }
  }

  async function cancelExceptional() {
    if (!exceptionalPreview?.activeCase) return;
    const active = exceptionalPreview.activeCase;
    setExceptionalBusy(true); setExceptionalError(""); setExceptionalMessage("");
    const keyFor = `${active.caseId}:${active.revision}`;
    let key = cancelKeys.current.get(keyFor);
    if (!key) { key = `exceptional-cancel-${crypto.randomUUID()}`; cancelKeys.current.set(keyFor, key); }
    try {
      const response = await fetch(`/api/installer/home-support/homes/${encodeURIComponent(homeId.trim())}/ownership-transfer/exceptional/${encodeURIComponent(active.caseId)}/cancel`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ expectedRevision: active.revision }),
      });
      await readResponse(response); setExceptionalClaim(null); setClaimQr("");
      setExceptionalPreview({ ...exceptionalPreview, activeCase: { ...active, status: "CANCELLED", revision: active.revision + 1, transferReference: null } });
      setExceptionalMessage("The case was cancelled and its outstanding transfer claim was invalidated.");
    } catch (reason) { setExceptionalError(reason instanceof Error ? reason.message : "Cancellation failed. Refresh the preview before retrying."); }
    finally { setExceptionalBusy(false); }
  }

  const privilegedTransferRole = employeeRole === "CXO" || employeeRole === "SENIOR_OPERATIONS_MANAGER";

  return <main className="mx-auto min-h-screen w-full max-w-5xl px-6 py-12">
    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Company Portal</p>
    <h1 className="mt-4 text-4xl font-semibold tracking-tight">Support access</h1>
    <p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Ticket creation never grants access. Select an assigned ticket, request the minimum scope, and wait for the correct customer approval.</p>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    {issuedCode && <section aria-live="polite" className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950"><h2 className="font-semibold">One-time support code — shown once</h2><p className="mt-2 text-sm">Enter this code only in the Dinodia OS support page opened for the approved request. Do not send it by email, chat or a URL.</p><code className="mt-3 block select-all rounded-lg bg-white px-4 py-3 text-lg font-bold tracking-wider">{issuedCode}</code><button type="button" onClick={() => setIssuedCode("")} className="mt-3 rounded-lg border border-amber-700 px-3 py-2 text-sm font-semibold">Hide code</button></section>}
    <section className="mt-8 grid gap-4">{tickets.length === 0 ? <p className="rounded-2xl border border-[var(--border)] p-6 text-[var(--muted)]">No assigned open tickets.</p> : tickets.map((ticket) => <article key={ticket.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><div className="flex flex-wrap justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{ticket.publicReference}</p><h2 className="mt-2 text-xl font-semibold">{ticket.category}</h2><p className="mt-2 text-sm text-[var(--muted)]">{ticket.description}</p></div><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm font-semibold">{ticket.status}</span></div><p className="mt-4 text-xs text-[var(--muted)]">{ticket.accessRequests.length} access request(s)</p><div className="mt-4 grid gap-2">{ticket.accessRequests.map((request) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 text-sm"><span>{request.requestedScope} · {request.status}</span>{request.status === "APPROVED" && <button type="button" onClick={() => issueCode(ticket, request.id)} className="rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white">Issue one-use code</button>}</div>)}</div></article>)}</section>
    <form onSubmit={requestAccess} className="mt-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><h2 className="text-xl font-semibold">Request customer-approved access</h2><label className="mt-5 block text-sm font-semibold" htmlFor="ticket">Ticket</label><select id="ticket" required value={ticketId} onChange={(event) => setTicketId(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="">Select an assigned ticket</option>{tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.publicReference} — {ticket.category}</option>)}</select><label className="mt-5 block text-sm font-semibold" htmlFor="scope">Minimum requested scope</label><select id="scope" value={scope} onChange={(event) => setScope(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="PROPERTY_SCOPE">Property diagnostics — homeowner/manager approval</option><option value="TENANT_SCOPE">Tenant devices/areas — tenant approval</option></select><p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error || result}</p><button disabled={!ticketId} className="mt-4 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">Request access</button></form>

    {privilegedTransferRole && <section className="mt-12 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">CXO / Senior Operations Manager · recent authentication required</p>
      <h2 className="mt-2 text-2xl font-semibold">Exceptional ownership transfer</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">Use only when the current owner cannot complete the normal transfer. Verify the property and proposed owner through the approved offline process. This creates a normal single-use claim; it does not directly change ownership or grant support, hub or commissioning access. A Stage 13 safety release is still required before submission can be enabled.</p>
      <form onSubmit={previewExceptional} className="mt-6 grid gap-4">
        <label className="grid gap-2 text-sm font-semibold">Home ID <input required value={homeId} onChange={(event) => { setHomeId(event.target.value); clearExceptionalResult(); }} className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" autoComplete="off" /></label>
        <label className="grid gap-2 text-sm font-semibold">Proposed incoming owner’s verified email <input required type="email" maxLength={320} value={proposedEmail} onChange={(event) => { setProposedEmail(event.target.value); clearExceptionalResult(); }} className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" autoComplete="off" /></label>
        <button disabled={exceptionalBusy || !homeId.trim() || !proposedEmail.trim()} className="w-fit rounded-xl border border-[var(--border)] px-5 py-3 font-semibold disabled:opacity-50">{exceptionalBusy ? "Checking…" : "Load read-only consequences"}</button>
      </form>
      {exceptionalPreview && <div className="mt-6 rounded-xl border border-[var(--border)] p-5" aria-live="polite">
        <h3 className="text-lg font-semibold">Read-only transfer preview</h3>
        <p className="mt-2 text-sm">Home: {exceptionalPreview.home?.retainedAddress || "Address unavailable"}</p>
        <p className="text-sm">Current owner: {exceptionalPreview.currentOwner ? `${exceptionalPreview.currentOwner.displayName} · ${exceptionalPreview.currentOwner.email}` : "Unavailable"}</p>
        <p className="mt-2 text-sm">Areas preserved: {exceptionalPreview.preserved.canonicalAreas} · Permanent devices preserved: {exceptionalPreview.preserved.permanentDevices} · Active tenants retained: {exceptionalPreview.preserved.activeTenantMemberships} · In-progress installation work preserved: {exceptionalPreview.preserved.inProgressInstallationWork}</p>
        <p className="mt-2 text-sm">Private tenant devices removed on completion: {exceptionalPreview.home?.privateDevicesRemoved ?? 0} · Floorplan kept for the successor: {exceptionalPreview.home?.floorplanRegeneratedForSuccessor ? "Yes" : "No"}</p>
        <h4 className="mt-4 font-semibold">Managers and outgoing notification recipients</h4>
        {exceptionalPreview.removedManagers.length ? <ul className="list-disc pl-5 text-sm">{exceptionalPreview.removedManagers.map((manager) => <li key={manager.membershipId}>{manager.displayName} · {manager.email}</li>)}</ul> : <p className="text-sm">No active managers.</p>}
        <h4 className="mt-4 font-semibold">Account cleanup preview</h4>
        {exceptionalPreview.cleanupEffects.map((effect) => <p key={effect.membershipId} className="text-sm">{effect.role}: {effect.finalRelationshipWouldBeRemoved ? "final Home relationship; account/session cleanup will run" : "other valid Home relationship remains"}</p>)}
        <p className="mt-3 text-sm">Active tenant as proposed successor: {exceptionalPreview.activeTenantSuccessorRejected ? "Blocked — use the required tenant-removal path first" : "No active-tenant conflict"}</p>
        {exceptionalPreview.currentOwnerSuccessorRejected && <p className="mt-2 text-sm">The current owner cannot be submitted as their own successor.</p>}
        <p className="mt-2 text-sm font-semibold">{exceptionalPreview.eligible ? "Eligible for the approved normal claim journey" : `Not eligible: ${exceptionalPreview.blockers.join(", ") || "refresh and review"}`}</p>
        {!exceptionalPreview.actionAvailable && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Submission remains disabled until the required Stage 13 lifecycle safety rehearsal and release.</p>}
        {exceptionalPreview.activeCase?.status && <p className="mt-2 text-sm">Existing case: {exceptionalPreview.activeCase.status}, revision {exceptionalPreview.activeCase.revision}. A matching available claim can be regenerated without creating a second transfer.</p>}
      </div>}
      {exceptionalPreview?.eligible && exceptionalPreview.actionAvailable && !exceptionalPreview.activeCase && <form onSubmit={submitExceptional} className="mt-6 grid gap-4 rounded-xl border border-[var(--border)] p-5">
        <h3 className="text-lg font-semibold">Required staff verification and attestation</h3>
        <label className="grid gap-2 text-sm font-semibold">Business reason <textarea required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-20 rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" /></label>
        <label className="grid gap-2 text-sm font-semibold">Offline identity/property verification method <input required maxLength={80} value={verificationMethod} onChange={(event) => setVerificationMethod(event.target.value)} className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" /></label>
        <label className="grid gap-2 text-sm font-semibold">Controlled evidence/reference (no credentials or unnecessary sensitive documents) <input required maxLength={200} value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} className="rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" /></label>
        <label className="grid gap-2 text-sm font-semibold">Staff attestation <textarea required maxLength={1000} value={staffAttestation} onChange={(event) => setStaffAttestation(event.target.value)} className="min-h-20 rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 font-normal" /></label>
        <p className="text-sm text-[var(--muted)]">The current owner remains owner until the proposed recipient completes the ordinary verified claim journey. Existing active tenants remain; the former owner and managers are removed only at successful completion.</p>
        <button disabled={exceptionalBusy || !reason.trim() || !verificationMethod.trim() || !verificationReference.trim() || !staffAttestation.trim()} className="w-fit rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">{exceptionalBusy ? "Submitting…" : "Create exceptional case and claim"}</button>
      </form>}
      {exceptionalError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{exceptionalError}</p>}
      {exceptionalMessage && <p aria-live="polite" className="mt-4 rounded-lg border border-[var(--border)] p-3 text-sm">{exceptionalMessage}</p>}
      {claimQr && exceptionalClaim && <div className="mt-5 flex flex-wrap items-center gap-5 rounded-xl border border-[var(--border)] p-4">
        {/* The claim reference is deliberately shown only as a QR; it is never written to browser storage or logs. */}
        <Image src={claimQr} width={280} height={280} unoptimized alt="Exceptional ownership transfer claim QR" className="rounded-lg bg-white p-2" />
        <div className="max-w-md text-sm"><h3 className="font-semibold">Normal claim QR ready</h3><p className="mt-2">Case {exceptionalClaim.caseId}, revision {exceptionalClaim.revision}. Show this QR only to the verified proposed recipient. The recipient must sign in, verify the account and complete the normal ownership-claim flow. Do not email the QR or share it in a support ticket.</p></div>
      </div>}
      {exceptionalPreview?.activeCase && ["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(exceptionalPreview.activeCase.status) && <button type="button" disabled={exceptionalBusy} onClick={cancelExceptional} className="mt-5 rounded-xl border border-red-300 px-5 py-3 font-semibold text-red-800 disabled:opacity-50">Cancel case and invalidate claim</button>}
    </section>}
  </main>;
}
