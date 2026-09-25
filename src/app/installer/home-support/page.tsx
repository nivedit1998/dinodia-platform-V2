"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type Ticket = { id: string; publicReference: string; category: string; status: string; homeId: string; description: string; accessRequests: { id: string; status: string; requestedScope: string; createdAt: string }[] };

export default function HomeSupportPage() {
  const params = useSearchParams();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketId, setTicketId] = useState("");
  const [scope, setScope] = useState("PROPERTY_SCOPE");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/company/support/tickets", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Portal session required"); return body; })
      .then((body) => { setTickets(body.tickets || []); if (params.get("ticketId")) setTicketId(params.get("ticketId")!); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Portal session required"));
  }, [params]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== "visible") setResult(""); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  async function requestAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setResult("");
    const response = await fetch(`/api/v2/support/tickets/${encodeURIComponent(ticketId)}/access-requests`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedScope: scope }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body.error || "Access request failed"); else setResult(`Access request ${body.accessRequest.id} created and is waiting for customer approval.`);
  }

  async function issueCode(ticket: Ticket, requestId: string) {
    setError(""); setResult("");
    const supportWindow = window.open("about:blank", "dinodia-os-support", "popup,width=720,height=760");
    const response = await fetch(`/api/v2/support/tickets/${encodeURIComponent(ticket.id)}/access-requests/${encodeURIComponent(requestId)}/issue`, { method: "POST", credentials: "same-origin" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { supportWindow?.close(); setError(body.error || "The support code could not be issued"); }
    else {
      const deliver = () => {
        try { supportWindow?.postMessage({ type: "dinodia-support-proof", ticketId: ticket.id }, new URL(String(body.supportUrl)).origin); } catch { /* popup may not be ready yet */ }
      };
      if (supportWindow) {
        supportWindow.location.href = String(body.supportUrl);
        supportWindow.addEventListener("load", deliver, { once: true });
        const retryTimer = window.setInterval(() => { if (supportWindow.closed) { window.clearInterval(retryTimer); return; } deliver(); }, 500);
        window.setTimeout(() => window.clearInterval(retryTimer), 15000);
      }
      setResult("The hub support page opened and received the encrypted employee authority automatically. Enter only the customer-approved one-use code there.");
    }
  }

  return <main className="mx-auto min-h-screen w-full max-w-5xl px-6 py-12">
    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">Company Portal</p>
    <h1 className="mt-4 text-4xl font-semibold tracking-tight">Support access</h1>
    <p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Ticket creation never grants access. Select an assigned ticket, request the minimum scope, and wait for the correct customer approval.</p>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    <section className="mt-8 grid gap-4">{tickets.length === 0 ? <p className="rounded-2xl border border-[var(--border)] p-6 text-[var(--muted)]">No assigned open tickets.</p> : tickets.map((ticket) => <article key={ticket.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><div className="flex flex-wrap justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{ticket.publicReference}</p><h2 className="mt-2 text-xl font-semibold">{ticket.category}</h2><p className="mt-2 text-sm text-[var(--muted)]">{ticket.description}</p></div><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm font-semibold">{ticket.status}</span></div><p className="mt-4 text-xs text-[var(--muted)]">{ticket.accessRequests.length} access request(s)</p><div className="mt-4 grid gap-2">{ticket.accessRequests.map((request) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 text-sm"><span>{request.requestedScope} · {request.status}</span>{request.status === "APPROVED" && <button type="button" onClick={() => issueCode(ticket, request.id)} className="rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white">Issue one-use code</button>}</div>)}</div></article>)}</section>
    <form onSubmit={requestAccess} className="mt-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]"><h2 className="text-xl font-semibold">Request customer-approved access</h2><label className="mt-5 block text-sm font-semibold" htmlFor="ticket">Ticket</label><select id="ticket" required value={ticketId} onChange={(event) => setTicketId(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="">Select an assigned ticket</option>{tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.publicReference} — {ticket.category}</option>)}</select><label className="mt-5 block text-sm font-semibold" htmlFor="scope">Minimum requested scope</label><select id="scope" value={scope} onChange={(event) => setScope(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border)] bg-transparent px-4 py-3"><option value="PROPERTY_SCOPE">Property diagnostics — homeowner/manager approval</option><option value="TENANT_SCOPE">Tenant devices/areas — tenant approval</option></select><p aria-live="polite" role={error ? "alert" : undefined} className="mt-4 min-h-6 text-sm text-red-700">{error || result}</p><button disabled={!ticketId} className="mt-4 rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-white disabled:opacity-50">Request access</button></form>
  </main>;
}
