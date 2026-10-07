"use client";

import { useCallback, useEffect, useState } from "react";

type Employee = { id: string; displayName: string; role: string };
type RequestRow = {
  requestId: string; reference: string; homeId: string; address: string; hubInstallationId: string | null;
  requestedAreaId: string | null; areaName: string | null; category: string; notes: string | null;
  status: string; revision: number; createdAt: string;
  work: null | { workflowId: string; assignedEmployeeId: string; state: string; revision: number };
};

export default function InstallationRequestsClient() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [role, setRole] = useState("");
  const [assignee, setAssignee] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const response = await fetch("/api/installer/installation-requests", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The installation queue could not be loaded");
    setRows(Array.isArray(body.requests) ? body.requests : []);
    setEmployees(Array.isArray(body.employees) ? body.employees : []);
    setEmployeeId(String(body.employee?.id || ""));
    setRole(String(body.employee?.role || ""));
  }, []);

  useEffect(() => { load().catch((caught) => setError(caught instanceof Error ? caught.message : "The installation queue could not be loaded")); }, [load]);

  async function transition(row: RequestRow, assignedEmployeeId?: string, complete = false) {
    if (busy) return;
    setBusy(row.requestId); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/installer/installation-requests/${encodeURIComponent(row.requestId)}/${complete ? "complete" : "start"}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": `install-work-${complete ? "complete" : "start"}-${crypto.randomUUID()}` },
        body: JSON.stringify(complete ? { expectedRevision: row.revision } : { expectedRevision: row.revision, ...(assignedEmployeeId ? { assignedEmployeeId } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The request changed; refresh the queue and try again");
      setNotice(complete ? "The installation result is recorded." : body.state === "ASSIGNED" ? "The request is assigned. The installer can open it from Assigned work." : "Work has started. Open the assigned Company Portal work to continue.");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The request could not be updated"); }
    finally { setBusy(null); }
  }

  return <>
    <div className="mt-6 flex flex-wrap gap-3">
      <a href="/installer" className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold">Assigned work</a>
      <button type="button" onClick={() => load().catch((caught) => setError(caught instanceof Error ? caught.message : "Refresh failed"))} disabled={busy !== null} className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold disabled:opacity-50">Refresh queue</button>
    </div>
    {error && <p role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    {notice && <p role="status" aria-live="polite" className="mt-6 rounded-xl border border-[var(--border)] p-4 text-sm">{notice}</p>}
    <section className="mt-8 grid gap-4" aria-label="Permanent installation requests">
      {rows.length === 0 && <p className="rounded-2xl border border-[var(--border)] p-6 text-[var(--muted)]">No installation requests are available to this staff account.</p>}
      {rows.map((row) => {
        const isAssignedHere = row.work?.assignedEmployeeId === employeeId;
        const assignedName = employees.find((employee) => employee.id === row.work?.assignedEmployeeId)?.displayName;
        return <article key={row.requestId} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{row.reference} · {row.category}</p><h2 className="mt-2 text-xl font-semibold">{row.address || "Address unavailable"}</h2><p className="mt-2 text-sm text-[var(--muted)]">{row.requestedAreaId ? row.areaName || "Requested Area no longer available" : "Whole property"} · Submitted {new Date(row.createdAt).toLocaleString()}</p>{row.notes && <p className="mt-3 whitespace-pre-wrap text-sm">{row.notes}</p>}</div><span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm font-semibold">{row.work?.state || row.status}</span></div>
          {row.work && <p className="mt-4 text-sm text-[var(--muted)]">Assigned to {assignedName || (isAssignedHere ? "you" : "another authorized installer")}</p>}
          {row.status === "SUBMITTED" && (role === "CXO" || role === "SENIOR_OPERATIONS_MANAGER") && <div className="mt-5 flex flex-wrap items-center gap-3"><label className="sr-only" htmlFor={`assignee-${row.requestId}`}>Assign installation request</label><select id={`assignee-${row.requestId}`} value={assignee[row.requestId] || ""} onChange={(event) => setAssignee((current) => ({ ...current, [row.requestId]: event.target.value }))} className="min-w-56 rounded-xl border border-[var(--border)] bg-transparent px-3 py-2"><option value="">Assign to me</option>{employees.filter((employee) => employee.role === "INSTALLER").map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} — Installer</option>)}</select><button type="button" disabled={busy !== null} onClick={() => transition(row, assignee[row.requestId] || undefined)} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === row.requestId ? "Assigning…" : assignee[row.requestId] ? "Assign request" : "Take and start"}</button></div>}
          {row.status === "SUBMITTED" && role === "INSTALLER" && <button type="button" disabled={busy !== null} onClick={() => transition(row)} className="mt-5 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === row.requestId ? "Starting…" : "Take and start"}</button>}
          {row.work?.assignedEmployeeId && isAssignedHere && row.work.state === "ASSIGNED" && <button type="button" disabled={busy !== null} onClick={() => transition(row)} className="mt-5 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Start assigned work</button>}
          {row.work?.assignedEmployeeId && isAssignedHere && row.work.state === "IN_PROGRESS" && <div className="mt-5 flex flex-wrap gap-3"><a href="/installer" className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white">Open assigned work in Company Portal</a><button type="button" disabled={busy !== null} onClick={() => transition(row, undefined, true)} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy === row.requestId ? "Recording…" : "Complete after device sync"}</button></div>}
        </article>;
      })}
    </section>
  </>;
}
