// Architecture: App Router surface src/app/rooms/requests/RoomAccessDecisionClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';

type DecisionKind = 'approve' | 'reject';

export function RoomAccessDecisionClient({ kind, token }: { kind: DecisionKind; token: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buttonVariant = useMemo(() => {
    return kind === 'reject' ? 'danger' : 'primary';
  }, [kind]);

  const label = kind === 'reject' ? 'Reject request' : 'Approve request';

  const onSubmit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/rooms/requests/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = (await res.json().catch(() => null)) as { ok?: boolean; status?: string } | null;
      const status = data?.status ?? 'ERROR';
      window.location.assign(`/rooms/requests/result?status=${encodeURIComponent(status)}`);
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }, [kind, token]);

  return (
    <div className="mt-4">
      <Button fullWidth variant={buttonVariant} loading={loading} onClick={() => void onSubmit()}>
        {label}
      </Button>
      {error ? <p className="mt-3 text-center text-xs text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}
