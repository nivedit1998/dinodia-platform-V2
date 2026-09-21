import { safeBuildId } from '@/lib/foundation';

export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ ok: true, service: 'dinodia-platform-v2', build: safeBuildId() }, { headers: { 'Cache-Control': 'no-store' } });
}
