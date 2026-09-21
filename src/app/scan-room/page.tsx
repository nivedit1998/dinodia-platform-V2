// Architecture: App Router surface src/app/scan-room/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/ui/AuthShell';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { RoomQrScanner } from '@/components/room/RoomQrScanner';
import { parseApiError } from '@/lib/authClientError';

type ScanResponse = { ok: true; room: { id: string; displayName: string } } | { ok?: false; error?: string; errorCode?: string };

export default function ScanRoomPage() {
  const router = useRouter();
  const [qr, setQr] = useState<string>('');
  const [roomName, setRoomName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const scanQr = useCallback(async (payload: string) => {
    setError(null);
    setSuccess(null);
    setRoomName(null);
    setQr(payload);
    const res = await fetch('/api/public/rooms/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr: payload }),
    });
    const data: ScanResponse = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
    if (!res.ok || !data.ok) {
      const parsed = parseApiError(data, 'Unable to scan this room QR right now.');
      setError(parsed.message);
      return;
    }
    setRoomName(data.room.displayName);
  }, []);

  useEffect(() => {
    if (!qr.trim()) return;
  }, [qr]);

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!qr.trim()) {
      setError('Please scan the room QR code first.');
      return;
    }
    if (!name.trim() || !email.trim() || !phoneNumber.trim()) {
      setError('Please enter your name, email, and phone number.');
      return;
    }

    setLoading(true);
    const res = await fetch('/api/public/rooms/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr, name: name.trim(), email: email.trim(), phoneNumber: phoneNumber.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) {
      const parsed = parseApiError(data, 'Unable to request access right now. Please try again.');
      setError(parsed.message);
      return;
    }

    setSuccess('Request sent. The homeowner or property manager will review your request by email.');
  }

  return (
    <AuthShell
      title="Scan room QR code"
      subtitle="Request access to a room in this home."
      footer={
        <button className="font-semibold text-[var(--indigo)] hover:underline" onClick={() => router.push('/login')}>
          Back to login
        </button>
      }
    >
      {error ? (
        <Card className="mb-4 rounded-[14px] border-[var(--danger)]/35 bg-[var(--danger)]/12 p-3 text-sm text-foreground">
          {error}
        </Card>
      ) : null}
      {success ? (
        <Card className="mb-4 rounded-[14px] border-border bg-surface-2/80 p-3 text-sm text-foreground">
          {success}
        </Card>
      ) : null}

      <div className="space-y-4">
        <RoomQrScanner onCode={scanQr} />

        {roomName ? (
          <Card surface="muted" className="rounded-[14px] p-3 text-sm">
            <div className="text-xs text-muted">Room</div>
            <div className="font-semibold text-foreground">{roomName}</div>
          </Card>
        ) : null}

        <form onSubmit={handleRequest} className="space-y-4">
          <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Field
            label="Phone number"
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            hint="Use E.164 format, e.g. +44..."
            required
          />
          <Button type="submit" loading={loading} fullWidth>
            Request access
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
