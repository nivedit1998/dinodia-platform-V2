'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { platformFetchJson } from '@/lib/platformFetchClient';
import { friendlyUnknownError } from '@/lib/clientError';

type Overview = {
  ok?: boolean;
  areas?: Array<{ id: string; label: string }>;
  tenants?: Array<{ userId: number; username: string; email: string | null; areaIds: string[] }>;
  sessions?: Array<{ id: string; ticketId: string; targetUserId: number | null; scope: string; areaIds: string[]; includesTenantDevices: boolean; status: string; approvedAt: string | null; expiresAt: string | null; redeemedAt: string | null; endedAt: string | null; hubRevokePending: boolean; createdAt: string }>;
};

type RevealedCode = { ticketId: string; code: string; employeeProof: string; expiresAt: string };

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function NativeSupportV2Panel({ homeId }: { homeId: number }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'PROPERTY_SCOPE' | 'TENANT_SCOPE'>('PROPERTY_SCOPE');
  const [targetUserId, setTargetUserId] = useState('');
  const [areaIds, setAreaIds] = useState<string[]>([]);
  const [reason, setReason] = useState('Dinodia OS support requested by the customer.');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<RevealedCode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await platformFetchJson<Overview>(`/api/installer/support/v2/homes/${homeId}/overview`, { cache: 'no-store' }, 'Unable to load native support scope.');
      setOverview(result);
      setAreaIds((current) => current.filter((id) => (result.areas ?? []).some((area) => area.id === id)));
    } catch (err) {
      setError(friendlyUnknownError(err, 'Unable to load native support scope.'));
    } finally {
      setLoading(false);
    }
  }, [homeId]);

  useEffect(() => {
    void load();
    return () => setRevealed(null);
  }, [homeId, load]);

  useEffect(() => {
    if (!revealed) return undefined;
    const timeout = window.setTimeout(() => setRevealed(null), Math.max(1, new Date(revealed.expiresAt).getTime() - Date.now()));
    const clear = () => setRevealed(null);
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('pagehide', clear);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', clear);
      window.removeEventListener('pagehide', clear);
    };
  }, [revealed]);

  const selectedTenant = useMemo(() => (overview?.tenants ?? []).find((tenant) => String(tenant.userId) === targetUserId), [overview, targetUserId]);

  function toggleArea(areaId: string) {
    setAreaIds((current) => current.includes(areaId) ? current.filter((id) => id !== areaId) : [...current, areaId]);
  }

  async function action(actionName: 'request' | 'issue-code' | 'revoke' | 'end', ticketId?: string) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action: actionName, ticketId };
      if (actionName === 'request') Object.assign(body, { homeId, scope, reason, targetUserId: scope === 'TENANT_SCOPE' ? Number(targetUserId) : null, areaIds: scope === 'TENANT_SCOPE' ? areaIds : [] });
      const result = await platformFetchJson<Record<string, unknown>>('/api/installer/support/v2/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Native support action failed.');
      if (actionName === 'issue-code' && typeof result.code === 'string' && typeof result.employeeProof === 'string' && typeof result.expiresAt === 'string') setRevealed({ ticketId: String(result.ticketId || ticketId), code: result.code, employeeProof: result.employeeProof, expiresAt: result.expiresAt });
      else setRevealed(null);
      await load();
    } catch (err) {
      setError(friendlyUnknownError(err, 'Native support action failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md bg-white p-3 shadow-inner ring-1 ring-indigo-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Native Dinodia OS support · V2</p>
          <p className="mt-1 text-xs text-slate-600">Ticket-bound access only. Customer approval is required before a code can be issued.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || busy} className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60">Refresh</button>
      </div>

      {error ? <p className="mt-2 text-xs text-rose-600" role="alert">{error}</p> : null}
      {revealed ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950" role="alert">
          <p className="font-semibold">Reveal once — clear this before leaving the page</p>
          <p className="mt-1">The code is valid until {formatDate(revealed.expiresAt)} and is useless without the assigned employee proof.</p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div><dt className="font-semibold">Support code</dt><dd className="break-all font-mono">{revealed.code}</dd></div>
            <div><dt className="font-semibold">Employee proof</dt><dd className="break-all font-mono">{revealed.employeeProof}</dd></div>
          </dl>
          <button type="button" onClick={() => setRevealed(null)} className="mt-3 rounded border border-amber-400 px-2 py-1 font-semibold hover:bg-amber-100">Clear now</button>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <label htmlFor={`support-v2-scope-${homeId}`} className="block text-xs font-semibold text-slate-700">Requested scope</label>
          <select id={`support-v2-scope-${homeId}`} value={scope} onChange={(event) => { setScope(event.target.value as 'PROPERTY_SCOPE' | 'TENANT_SCOPE'); setAreaIds([]); }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs">
            <option value="PROPERTY_SCOPE">Property diagnostics (no tenant devices)</option>
            <option value="TENANT_SCOPE">One tenant’s authorised scope</option>
          </select>
        </div>
        {scope === 'TENANT_SCOPE' ? (
          <div>
            <label htmlFor={`support-v2-tenant-${homeId}`} className="block text-xs font-semibold text-slate-700">Tenant</label>
            <select id={`support-v2-tenant-${homeId}`} value={targetUserId} onChange={(event) => { setTargetUserId(event.target.value); setAreaIds([]); }} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs">
              <option value="">Select tenant</option>
              {(overview?.tenants ?? []).map((tenant) => <option key={tenant.userId} value={tenant.userId}>{tenant.username}{tenant.email ? ` · ${tenant.email}` : ''}</option>)}
            </select>
          </div>
        ) : <div />}
        <div>
          <label htmlFor={`support-v2-reason-${homeId}`} className="block text-xs font-semibold text-slate-700">Reason</label>
          <input id={`support-v2-reason-${homeId}`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs" />
        </div>
      </div>

      {scope === 'TENANT_SCOPE' ? (
        <fieldset className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <legend className="px-1 text-xs font-semibold text-slate-700">Exact authorised areas</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(selectedTenant?.areaIds ?? []).map((areaId) => {
              const label = overview?.areas?.find((area) => area.id === areaId)?.label ?? areaId;
              return <label key={areaId} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={areaIds.includes(areaId)} onChange={() => toggleArea(areaId)} />{label}</label>;
            })}
          </div>
          {!selectedTenant ? <p className="mt-1 text-xs text-slate-500">Select a tenant to load their current area grants.</p> : null}
        </fieldset>
      ) : null}

      <button type="button" onClick={() => void action('request')} disabled={busy || loading || (scope === 'TENANT_SCOPE' && (!targetUserId || areaIds.length === 0))} className="mt-3 rounded border border-indigo-300 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-900 hover:bg-indigo-100 disabled:opacity-60">{busy ? 'Working…' : 'Request customer approval'}</button>

      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your V2 support sessions</p>
        {(overview?.sessions ?? []).length === 0 ? <p className="text-xs text-slate-600">No native support sessions for this home.</p> : null}
        {(overview?.sessions ?? []).map((session) => (
          <div key={session.id} className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-900">{session.scope} · {session.status}</p><span className="text-[11px] text-slate-500">Created {formatDate(session.createdAt)}</span></div>
            <p className="mt-1 text-[11px] text-slate-600">Ticket {session.ticketId} · Areas {session.areaIds.length || 'property-wide'} · Expires {formatDate(session.expiresAt)}{session.hubRevokePending ? ' · Hub revocation pending' : ''}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {session.status === 'APPROVED' ? <button type="button" onClick={() => void action('issue-code', session.ticketId)} disabled={busy} className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-white disabled:opacity-60">Issue one-use code</button> : null}
              {['PENDING', 'APPROVED', 'ACTIVE'].includes(session.status) ? <button type="button" onClick={() => void action('revoke', session.ticketId)} disabled={busy} className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-800 hover:bg-rose-100 disabled:opacity-60">Revoke</button> : null}
              {['PENDING', 'APPROVED', 'ACTIVE'].includes(session.status) ? <button type="button" onClick={() => void action('end', session.ticketId)} disabled={busy} className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-white disabled:opacity-60">End ticket access</button> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
