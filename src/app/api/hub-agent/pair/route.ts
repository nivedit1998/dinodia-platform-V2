// Architecture: API boundary /hub-agent/pair; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
// Architecture boundary: authenticated Hub Agent bootstrap endpoint. The local
// add-on signs serial/timestamp/nonce requests, this route verifies replay/HMAC
// protection and returns the next token-state material needed by the agent.

import { NextRequest } from 'next/server';
import { apiFailFromStatus } from '@/lib/apiError';

export async function POST(_req: NextRequest) {
  void _req;
  // The legacy bootstrap-secret exchange is intentionally retired for the
  // native Dinodia OS stack. Hub pairing must use the signed V2 outbound
  // attempt contract; never return a reusable sync secret here.
  return apiFailFromStatus(410, 'Legacy hub bootstrap pairing is retired.', { errorCode: 'legacy_pairing_retired' });
}
