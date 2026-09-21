// Architecture: App Router surface src/app/qr/room/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import QrRoomClient from './QrRoomClient';
import { getIosAppStoreUrlConfig } from '@/lib/appStoreUrl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function QrRoomPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const v = typeof params.v === 'string' ? params.v : Array.isArray(params.v) ? params.v[0] : undefined;
  const rid = typeof params.rid === 'string' ? params.rid : Array.isArray(params.rid) ? params.rid[0] : undefined;
  const t = typeof params.t === 'string' ? params.t : Array.isArray(params.t) ? params.t[0] : undefined;
  const { appStoreUrl, configError } = getIosAppStoreUrlConfig();

  if (configError) {
    console.error(`QR room App Store URL config error: ${configError}`);
  }

  return (
    <QrRoomClient
      v={v ?? null}
      rid={rid ?? null}
      token={t ?? null}
      appStoreUrl={appStoreUrl}
      configError={configError}
    />
  );
}
