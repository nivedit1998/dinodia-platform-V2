import { NextResponse } from 'next/server';
import { Stage1AuthError, authErrorResponse } from '@/lib/stage1Auth';
import { discoverNativeAlexa } from '@/lib/nativeAlexaDiscovery';
import { nativeFeatureNotEnabled } from '@/lib/contracts/nativeFeatureBoundary';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return nativeFeatureNotEnabled('Native Alexa discovery');
  try {
    const result = await discoverNativeAlexa(request);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof Stage1AuthError && error.status === 401) {
      return NextResponse.json({ error: { code: 'INVALID_AUTHORIZATION_CREDENTIAL', message: 'A current Alexa authorization is required' } }, { status: 401, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
    }
    return authErrorResponse(error);
  }
}
