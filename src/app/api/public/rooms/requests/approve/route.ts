// Architecture: API boundary /public/rooms/requests/approve; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { RoomAccessApprovalKind } from '@prisma/client';
import { approveOrRejectRoomAccessByToken } from '@/lib/roomAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectWithStatus(req: NextRequest, status: string) {
  const url = new URL('/rooms/requests/result', req.url);
  url.searchParams.set('status', status);
  return NextResponse.redirect(url, { status: 302 });
}

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token')?.trim() ?? '';
  if (!token) return redirectWithStatus(req, 'NOT_FOUND');

  // Backwards compatible: old emails linked directly to this GET endpoint.
  // Redirect to the side-effect-free preview page, which will POST when the user confirms.
  const url = new URL('/rooms/requests/approve', req.url);
  url.searchParams.set('token', token);
  return NextResponse.redirect(url, { status: 302 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const token = typeof obj?.token === 'string' ? obj.token.trim() : '';
  if (!token) return NextResponse.json({ ok: false, status: 'NOT_FOUND' }, { status: 400 });

  try {
    const result = await approveOrRejectRoomAccessByToken({ tokenRaw: token, kind: RoomAccessApprovalKind.APPROVE });
    if (!result.ok) return NextResponse.json({ ok: false, status: result.reason }, { status: 200 });
    return NextResponse.json({ ok: true, status: result.decision }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, status: 'ERROR' }, { status: 200 });
  }
}
