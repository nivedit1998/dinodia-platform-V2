import { NextResponse } from 'next/server';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { acceptNativeAlexaGrant } from '@/lib/nativeAlexaGrant';
import { nativeFeatureNotEnabled } from '@/lib/contracts/nativeFeatureBoundary';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return nativeFeatureNotEnabled('Native Alexa event-gateway linking');
  try {
    const body = await request.json().catch(() => null) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body as Record<string, unknown>).sort().join(',') !== 'grantCode,messageId'
      || typeof (body as Record<string, unknown>).messageId !== 'string'
      || typeof (body as Record<string, unknown>).grantCode !== 'string') {
      throw new Stage1AuthError(400, 'alexa_grant_invalid', 'The Alexa permission request is invalid');
    }
    const result = await acceptNativeAlexaGrant(request, body as { messageId: string; grantCode: string });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
