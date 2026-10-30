import { NextResponse } from 'next/server';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { sha256 } from '@/lib/stage1Crypto';
import { identifyCustomerEmail } from '@/lib/customerIdentify';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'email' || typeof body.email !== 'string') {
      throw new Stage1AuthError(400, 'customer_identify_invalid', 'Enter a valid email address');
    }
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new Stage1AuthError(400, 'customer_identify_invalid', 'Enter a valid email address');
    }
    const source = String(request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'unknown').split(',')[0].trim();
    await enforcePersistentRateLimit(`customer-identify-source:${sha256(source)}`, 60, 10 * 60 * 1000);
    await enforcePersistentRateLimit(`customer-identify-email:${sha256(email)}`, 10, 15 * 60 * 1000);
    const state = await identifyCustomerEmail(email);
    return NextResponse.json({ schemaVersion: 'dinodia.v1', ok: true, state }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
