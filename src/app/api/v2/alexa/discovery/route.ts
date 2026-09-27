import { nativeFeatureNotEnabled } from '@/lib/contracts/nativeFeatureBoundary';

export async function GET() {
  return nativeFeatureNotEnabled('Native Alexa discovery');
}
