// Architecture: Stage 1 installer provisioning surface. The browser enters
// only the hub-generated short-lived pairing presentation. Serial/BaseURL are
// read-only values proven by the hub; HA credentials, bootstrap secrets and
// Cloudflare account tokens are intentionally absent.
'use client';

import { useEffect, useState } from 'react';
import { Role } from '@prisma/client';

type ProvisionResponse = {
  ok?: boolean;
  phase?: string;
  pairingId?: string;
  serial?: string;
  baseUrl?: string;
  cloudUrl?: string | null;
  homeQr?: string | null;
  claimState?: { pendingInstallation?: boolean } | null;
  error?: string;
};

type InstallationWorkflow = {
  id: string;
  homeId: number;
  hubInstallId: string;
  hubSerial: string;
  status: string;
  expiresAt?: string | null;
};

function readPairingValue(input: string) {
  return input.trim();
}

export default function ProvisionClient({ role }: { installerName: string; role: Role }) {
  const [presentation, setPresentation] = useState('');
  const [installationWorkflowId, setInstallationWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<InstallationWorkflow[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(true);
  const [status, setStatus] = useState('Enter the short-lived code generated on the hub’s private /setup page.');
  const [phase, setPhase] = useState('PAIRING_REQUIRED');
  const [result, setResult] = useState<ProvisionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/installer/workflows', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { workflows?: InstallationWorkflow[]; error?: string };
        if (!response.ok) throw new Error(data.error || 'Assigned installation work could not be loaded.');
        if (!active) return;
        const available = Array.isArray(data.workflows) ? data.workflows : [];
        setWorkflows(available);
        if (available.length === 1) setInstallationWorkflowId(available[0].id);
      })
      .catch((error) => { if (active) setStatus(error instanceof Error ? error.message : 'Assigned installation work could not be loaded.'); })
      .finally(() => { if (active) setWorkflowLoading(false); });
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    setStatus('Checking the hub-generated presentation…');
    try {
      const response = await fetch('/api/installer/hubs/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ pairingCode: readPairingValue(presentation), installationWorkflowId: installationWorkflowId.trim() }),
      });
      const data = await response.json().catch(() => ({})) as ProvisionResponse;
      if (!response.ok) throw new Error(data.error || 'Pairing was not accepted.');
      setResult(data);
      setPhase(data.phase || 'HUB_PROOF_ACCEPTED');
      setStatus('The pairing presentation was accepted. The hub must now complete its outbound proof and credential acknowledgement.');
    } catch (error) {
      setPhase('PAIRING_RETRY_REQUIRED');
      setStatus(error instanceof Error ? error.message : 'Pairing was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function completeInstallation() {
    if (!result?.pairingId) return;
    setCompleteBusy(true);
    try {
      const response = await fetch('/api/installer/hubs/provision', { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ action: 'complete_installation', pairingId: result.pairingId, workflowId: installationWorkflowId.trim() }) });
      const data = await response.json().catch(() => ({})) as ProvisionResponse;
      if (!response.ok) throw new Error(data.error || 'Installation could not be completed.');
      setPhase(data.phase || 'INSTALLATION_COMPLETE');
      setResult((current) => current ? { ...current, homeQr: data.homeQr, claimState: { pendingInstallation: false } } : current);
      setStatus('Installation is complete. The secure Home QR claim presentation is now available.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Installation could not be completed.');
    } finally { setCompleteBusy(false); }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Native provisioning · Stage 1</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Pair a Dinodia OS hub</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Signed in as an authorised {role.replaceAll('_', ' ').toLowerCase()}. Open the hub’s locked <code>http://dinodia-&lt;serial&gt;.local/setup</code> page on the isolated portable-router network, generate one code, then enter or scan it here.</p>
        <form onSubmit={submit} className="mt-7 space-y-3">
          <label className="block text-sm font-medium text-slate-800" htmlFor="pairing-code">Hub pairing code or QR payload</label>
          <input id="pairing-code" value={presentation} onChange={(event) => setPresentation(event.target.value)} autoComplete="one-time-code" spellCheck={false} required className="w-full rounded-2xl border border-slate-300 px-4 py-3 font-mono text-sm outline-none ring-emerald-500 focus:ring-2" placeholder="DNO-…" />
          <label className="block text-sm font-medium text-slate-800" htmlFor="installation-workflow">Assigned installation work</label>
          <select id="installation-workflow" value={installationWorkflowId} onChange={(event) => setInstallationWorkflowId(event.target.value)} required disabled={workflowLoading || busy || workflows.length === 0} className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none ring-emerald-500 focus:ring-2 disabled:bg-slate-100">
            <option value="">{workflowLoading ? 'Loading assigned work…' : workflows.length ? 'Select the approved installation' : 'No approved installation is assigned to you'}</option>
            {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>Home {workflow.homeId} · Hub {workflow.hubSerial} · {workflow.status.toLowerCase()}</option>)}
          </select>
          <p className="text-xs leading-5 text-slate-500">Only installation work assigned to your signed-in Company Portal identity appears here. The selected ID is looked up and rechecked by the server.</p>
          <button type="submit" disabled={busy || workflowLoading || !installationWorkflowId} className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Verifying…' : 'Verify hub pairing'}</button>
        </form>
        <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600" role="status">{status}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-5">
        {['Pairing', 'Hub proof', 'Credential delivery', 'Cloudflare', 'Complete'].map((label, index) => {
          const active = index === 0 ? phase === 'PAIRING_REQUIRED' || phase === 'PAIRING_RETRY_REQUIRED' : index === 1 ? phase === 'HUB_PROOF_ACCEPTED' : false;
          return <div key={label} className={`rounded-2xl border p-4 text-sm ${active ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-slate-200 bg-white text-slate-500'}`}><span className="font-semibold">{index + 1}. {label}</span><p className="mt-1 text-xs">{active ? 'Current action' : 'Not yet available'}</p></div>;
        })}
      </div>

      {result && <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-950"><strong>Hub identity proven by the Stage 1 contract.</strong><dl className="mt-4 grid gap-3 sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-emerald-700">Serial</dt><dd className="font-mono">{result.serial || '—'}</dd></div><div><dt className="text-xs uppercase tracking-wide text-emerald-700">BaseURL</dt><dd className="font-mono">{result.baseUrl || '—'}</dd></div></dl><div className="mt-5 rounded-2xl bg-white/70 p-4"><strong>Home QR claim presentation</strong><p className="mt-1 text-emerald-800">Available immediately as an opaque secure reference. It remains pending until an authorised employee marks installation complete.</p><code className="mt-3 block break-all rounded-xl bg-slate-950 p-3 text-xs text-white">{result.homeQr || 'Pending pairing completion'}</code><button type="button" disabled={completeBusy || !result.homeQr || result.claimState?.pendingInstallation !== true} onClick={completeInstallation} className="mt-4 rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{completeBusy ? 'Completing…' : 'Mark installation complete'}</button></div><p className="mt-4 text-emerald-800">CloudURL verification is a separate required installation-completion step; it must be completed before the property dashboard is released.</p></div>}
    </section>
  );
}
