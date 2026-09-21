// Architecture: App Router surface src/app/opengraph-image.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import path from 'path';
import { readFile } from 'fs/promises';
import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

export default async function OpengraphImage() {
  const logoPath = path.join(process.cwd(), 'public', 'brand', 'logo-mark.png');
  const logoArray = await readFile(logoPath);
  const logoBase64 = `data:image/png;base64,${logoArray.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f172a, #111827 40%, #1e293b)',
          color: '#e2e8f0',
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 28,
            padding: '32px 44px',
            borderRadius: 32,
            background: 'rgba(255,255,255,0.06)',
            boxShadow: '0 30px 60px rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              height: 120,
              width: 120,
              borderRadius: 28,
              background: 'rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <img
              src={logoBase64}
              alt="Dinodia logo"
              width={84}
              height={84}
              style={{ objectFit: 'contain' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: -1 }}>
              Dinodia Smart Living
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 500,
                color: '#cbd5e1',
              }}
            >
              Smart home portal for the Dinodia Hub (Home Assistant)
            </div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
