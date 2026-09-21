// Architecture: App Router surface src/app/qr/room/QrRoomClient.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
'use client';

import { useEffect, useMemo } from 'react';

export default function QrRoomClient({
  v,
  rid,
  token,
  appStoreUrl,
  configError,
}: {
  v: string | null;
  rid: string | null;
  token: string | null;
  appStoreUrl: string | null;
  configError: string | null;
}) {
  const deepLink = useMemo(() => {
    const version = (v ?? '1').trim() || '1';
    const roomId = (rid ?? '').trim();
    const t = (token ?? '').trim();
    const query = new URLSearchParams({ v: version, rid: roomId, t });
    return `dinodia://room?${query.toString()}`;
  }, [v, rid, token]);

  const isValid = Boolean((rid ?? '').trim() && (token ?? '').trim());

  useEffect(() => {
    if (!isValid) return;
    const fallbackMs = 1400;
    window.location.href = deepLink;
    const timer = window.setTimeout(() => {
      if (appStoreUrl) {
        window.location.href = appStoreUrl;
      }
    }, fallbackMs);
    return () => window.clearTimeout(timer);
  }, [appStoreUrl, deepLink, isValid]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
        <h1 className="text-xl font-semibold text-slate-900">Opening Dinodia…</h1>
        <p className="mt-2 text-sm text-slate-600">
          {isValid
            ? 'If nothing happens, use the buttons below.'
            : 'This QR link is missing required details. Ask your installer to regenerate the room QR code.'}
        </p>
        {configError ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            App download is temporarily unavailable. Please contact support.
          </p>
        ) : null}

        <div className="mt-5 grid gap-3">
          <a
            href={isValid ? deepLink : '#'}
            className={[
              'inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold',
              isValid ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-slate-200 text-slate-500 cursor-not-allowed',
            ].join(' ')}
          >
            Open Dinodia
          </a>
          {appStoreUrl ? (
            <a
              href={appStoreUrl}
              className="inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold bg-white text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Get the app
            </a>
          ) : (
            <span className="inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold bg-slate-100 text-slate-500 ring-1 ring-slate-200">
              Get the app
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
