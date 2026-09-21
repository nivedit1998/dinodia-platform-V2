// Architecture: API boundary /auth/installer-bootstrap; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Deprecated. Bootstrap the first CXO with a one-time SQL insert.' },
    { status: 410 }
  );
}
