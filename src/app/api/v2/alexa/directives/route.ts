import { nativeFeatureNotEnabled } from '@/lib/contracts/nativeFeatureBoundary';

export async function POST() {
  return nativeFeatureNotEnabled('Native Alexa directive execution');
}
