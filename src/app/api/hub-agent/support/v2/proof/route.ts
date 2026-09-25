import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { authenticateHub } from '@/lib/stage1HubAuth';

export const dynamic = 'force-dynamic';

/**
 * Return the encrypted employee proof only to the already-authenticated hub.
 * Company Portal never receives this envelope. The subsequent redeem request
 * consumes the matching one-use support request atomically.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw);
    const ticketId = String(hub.body.ticketId ?? '').trim();
    if (!ticketId || ticketId.length > 256) throw new Stage1AuthError(400, 'support_proof_invalid', 'A valid support ticket is required');
    const now = new Date();
    const row = await prisma.supportAccessRequest.findFirst({
      where: {
        ticketId,
        hubInstallationId: hub.installation.id,
        status: 'ISSUED',
        employeeHandoffConsumedAt: null,
        employeeHandoffExpiresAt: { gt: now },
        employeeHandoffEnvelope: { not: null },
      },
      orderBy: { employeeHandoffIssuedAt: 'desc' },
      select: { id: true, employeeHandoffEnvelope: true },
    });
    if (!row?.employeeHandoffEnvelope) throw new Stage1AuthError(401, 'support_proof_unavailable', 'The approved support handoff is unavailable or expired');
    return NextResponse.json({ ok: true, requestId: row.id, identityGeneration: hub.identity.identityGeneration, employeeProofEnvelope: row.employeeHandoffEnvelope }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
