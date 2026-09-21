// Architecture: App Router surface src/app/homeowner/policy/HomeownerPolicyForm.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { HOMEOWNER_POLICY_STATEMENTS, type HomeownerPolicyStatementKey } from '@/lib/homeownerPolicyStatements';

type PolicyStatusResponse = {
  ok?: boolean;
  error?: string;
  policyVersion?: string;
  requiresAcceptance?: boolean;
  emailVerified?: boolean;
  pendingOnboardingId?: string | null;
};

type AcceptResponse = {
  ok?: boolean;
  error?: string;
  pendingOnboardingId?: string | null;
};

type FinalizeResponse = {
  ok?: boolean;
  error?: string;
};

const statementDefaults = HOMEOWNER_POLICY_STATEMENTS.reduce<Record<HomeownerPolicyStatementKey, boolean>>(
  (acc, item) => {
    acc[item.key] = false;
    return acc;
  },
  {} as Record<HomeownerPolicyStatementKey, boolean>
);

export default function HomeownerPolicyForm(props: {
  initialPolicyVersion: string;
  initialPendingOnboardingId: string | null;
}) {
  const router = useRouter();
  const [policyVersion, setPolicyVersion] = useState(props.initialPolicyVersion);
  const [pendingOnboardingId, setPendingOnboardingId] = useState<string | null>(props.initialPendingOnboardingId);
  const [emailVerified, setEmailVerified] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [signatureName, setSignatureName] = useState('');
  const [iAgree, setIAgree] = useState(false);
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [postcode, setPostcode] = useState('');
  const [country, setCountry] = useState('United Kingdom');
  const [notificationPreference, setNotificationPreference] = useState('email');
  const [approvedSupportContacts, setApprovedSupportContacts] = useState('');
  const [statements, setStatements] = useState(statementDefaults);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      setLoadingStatus(true);
      try {
        const res = await fetch('/api/homeowner/policy/status', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as PolicyStatusResponse;
        if (!res.ok || !data.ok) {
          throw new Error(data?.error || 'Unsuccessful - unable to load homeowner policy status.');
        }
        if (cancelled) return;
        if (data.requiresAcceptance === false) {
          router.replace('/admin/dashboard');
          return;
        }
        setPolicyVersion(data.policyVersion || props.initialPolicyVersion);
        setEmailVerified(Boolean(data.emailVerified));
        setPendingOnboardingId(data.pendingOnboardingId ?? props.initialPendingOnboardingId ?? null);
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Unsuccessful - unable to load homeowner policy status.';
          setError(message);
        }
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [props.initialPendingOnboardingId, props.initialPolicyVersion, router]);

  const allStatementsAccepted = useMemo(
    () => HOMEOWNER_POLICY_STATEMENTS.every((item) => statements[item.key]),
    [statements]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setInfo(null);

    if (!emailVerified) {
      setError('Please verify your email first to continue.');
      return;
    }

    if (!iAgree) {
      setError('Please confirm your agreement to continue.');
      return;
    }

    if (!allStatementsAccepted) {
      setError('Please accept all required statements.');
      return;
    }

    if (!signatureName.trim()) {
      setError('Type your full name to sign.');
      return;
    }

    if (!addressLine1.trim() || !city.trim() || !postcode.trim() || !country.trim()) {
      setError('Address line 1, city, postcode, and country are required.');
      return;
    }

    setSubmitting(true);
    try {
      const contacts = approvedSupportContacts
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      const acceptRes = await fetch('/api/homeowner/policy/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureName: signatureName.trim(),
          acceptedStatements: statements,
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim() || null,
          city: city.trim(),
          state: stateRegion.trim() || null,
          postcode: postcode.trim(),
          country: country.trim(),
          notificationPreference,
          approvedSupportContacts: contacts,
          pendingOnboardingId,
        }),
      });

      const acceptData = (await acceptRes.json().catch(() => ({}))) as AcceptResponse;
      if (!acceptRes.ok || !acceptData.ok) {
        throw new Error(
          acceptData.error || 'Unsuccessful - unable to accept the homeowner policy.'
        );
      }

      const effectivePendingId = acceptData.pendingOnboardingId ?? pendingOnboardingId;
      if (effectivePendingId) {
        const finalizeRes = await fetch('/api/homeowner/onboarding/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingOnboardingId: effectivePendingId }),
        });
        const finalizeData = (await finalizeRes.json().catch(() => ({}))) as FinalizeResponse;
        if (!finalizeRes.ok || !finalizeData.ok) {
          throw new Error(
            finalizeData.error ||
              'Policy accepted, but onboarding could not be completed right now.'
          );
        }
      }

      setInfo('Policy accepted. Taking you to your dashboard...');
      router.replace('/admin/dashboard');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unsuccessful - we could not complete homeowner policy acceptance.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
      <h1 className="text-2xl font-semibold text-slate-900">Homeowner Terms & Conditions</h1>
      <p className="mt-2 text-sm text-slate-600">
        Policy version: <span className="font-semibold text-slate-900">{policyVersion}</span>
      </p>

      {loadingStatus && <p className="mt-4 text-sm text-slate-600">Loading policy status…</p>}

      {!loadingStatus && (
        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          {!emailVerified && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              Please verify your email from the previous step before accepting this policy.
            </p>
          )}

          {error && <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          {info && <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{info}</p>}

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Required statements</h2>
            <div className="mt-3 space-y-3">
              {HOMEOWNER_POLICY_STATEMENTS.map((item) => (
                <label key={item.key} className="flex items-start gap-3 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={Boolean(statements[item.key])}
                    onChange={(event) =>
                      setStatements((current) => ({ ...current, [item.key]: event.target.checked }))
                    }
                    className="mt-0.5"
                  />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>
            <label className="mt-4 flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={iAgree}
                onChange={(event) => setIAgree(event.target.checked)}
                className="mt-0.5"
              />
              <span>I agree to these homeowner terms and conditions.</span>
            </label>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Signature</h2>
            <input
              type="text"
              value={signatureName}
              onChange={(event) => setSignatureName(event.target.value)}
              placeholder="Type your full legal name"
              className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Property address (re-enter)</h2>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
              <input
                type="text"
                value={addressLine1}
                onChange={(event) => setAddressLine1(event.target.value)}
                placeholder="Address line 1"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm md:col-span-2"
                required
              />
              <input
                type="text"
                value={addressLine2}
                onChange={(event) => setAddressLine2(event.target.value)}
                placeholder="Address line 2 (optional)"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm md:col-span-2"
              />
              <input
                type="text"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                placeholder="City"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <input
                type="text"
                value={stateRegion}
                onChange={(event) => setStateRegion(event.target.value)}
                placeholder="County/State (optional)"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={postcode}
                onChange={(event) => setPostcode(event.target.value)}
                placeholder="Postcode"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <input
                type="text"
                value={country}
                onChange={(event) => setCountry(event.target.value)}
                placeholder="Country"
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                required
              />
            </div>
          </section>

          <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Support notifications</h2>
              <select
                value={notificationPreference}
                onChange={(event) => setNotificationPreference(event.target.value)}
                className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="app">App notification</option>
              </select>
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Approved support contacts (optional)</h2>
              <input
                type="text"
                value={approvedSupportContacts}
                onChange={(event) => setApprovedSupportContacts(event.target.value)}
                placeholder="name1@example.com, name2@example.com"
                className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </section>

          <button
            type="submit"
            disabled={submitting || !emailVerified}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? 'Saving...' : 'Accept terms and continue'}
          </button>
        </form>
      )}
    </div>
  );
}
