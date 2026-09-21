// Architecture: API boundary /alexa/auth.ts; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest } from 'next/server';
import { AuthUser, getCurrentUserFromRequest } from '@/lib/auth';

export async function resolveAlexaAuthUser(req: NextRequest): Promise<AuthUser | null> {
  return getCurrentUserFromRequest(req);
}
