import { NextResponse } from 'next/server';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { nativeFeatureNotEnabled } from '@/lib/contracts/nativeFeatureBoundary';
import { handleNativeAlexaReportState } from '@/lib/nativeAlexaExecution';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return nativeFeatureNotEnabled('Native Alexa report-state');
  try {
    return NextResponse.json(await handleNativeAlexaReportState(request), { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  } catch (error) {
    if (error instanceof Stage1AuthError && error.status === 413) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
    return authErrorResponse(error);
  }
}
