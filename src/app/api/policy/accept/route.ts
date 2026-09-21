// Architecture: API boundary /policy/accept; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextRequest, NextResponse } from 'next/server';
import { PolicyKind } from '@prisma/client';
import { getCurrentUserFromRequest } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PRIVACY_NOTICE_VERSION, TERMS_VERSION } from '@/lib/policyVersions';
import { hashForLog } from '@/lib/safeLogger';
import { getClientIp } from '@/lib/requestInfo';
import { logServerError } from '@/lib/serverErrorLog';

function normalizeKind(value: unknown): PolicyKind | null {
  if (value === 'PRIVACY_NOTICE') return PolicyKind.PRIVACY_NOTICE;
  if (value === 'TERMS') return PolicyKind.TERMS;
  return null;
}

function currentVersionForKind(kind: PolicyKind): string {
  return kind === PolicyKind.PRIVACY_NOTICE ? PRIVACY_NOTICE_VERSION : TERMS_VERSION;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUserFromRequest(req);
    if (!user) return NextResponse.json({ ok: false, error: 'Authentication required.' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const kind = normalizeKind(body?.kind);
    const version = typeof body?.version === 'string' ? body.version.trim() : '';
    if (!kind || !version) {
      return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 });
    }

    const expectedVersion = currentVersionForKind(kind);
    if (version !== expectedVersion) {
      return NextResponse.json({ ok: false, error: 'Policy version mismatch.' }, { status: 409 });
    }

    const ipHash = hashForLog(getClientIp(req));
    const deviceFingerprintHash = hashForLog(req.headers.get('x-device-id'));

    await prisma.policyAcceptance.upsert({
      where: {
        userId_policyKind_policyVersion: {
          userId: user.id,
          policyKind: kind,
          policyVersion: expectedVersion,
        },
      },
      update: {},
      create: {
        userId: user.id,
        policyKind: kind,
        policyVersion: expectedVersion,
        ipHash,
        deviceFingerprintHash,
      },
    });

    return NextResponse.json({ ok: true, kind, version: expectedVersion });
  } catch (err) {
    logServerError('[api/policy/accept] unhandled', err);
    return NextResponse.json({ ok: false, error: 'Unable to record acceptance.' }, { status: 500 });
  }
}
