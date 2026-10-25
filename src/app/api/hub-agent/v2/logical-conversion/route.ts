import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { assertFullHomeOperator } from '@/lib/fullHomeOperatorAuthority';
import { logicalDeviceConversion } from '@/lib/logicalDeviceConversion';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { maxBodyBytes: 256 * 1024 });
    const body = hub.body;
    const allowed = new Set(['serial', 'identityGeneration', 'action', 'operationId', 'osDeviceId', 'channels',
      'protocolIdentityHash', 'digest', 'confirmationName', 'handoffId', 'jti', 'credentialVersion', 'assignment']);
    if (Object.keys(body).some(key => !allowed.has(key)) || !['preview', 'reserve', 'commit', 'assign'].includes(String(body.action))
      || !/^[0-9a-f-]{36}$/i.test(String(body.operationId)) || !/^[A-Za-z0-9:_-]{1,160}$/.test(String(body.osDeviceId)))
      throw new Stage1AuthError(400, 'logical_conversion_invalid', 'Review an exact existing device');
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${hub.installation.homeId}::uuid FOR UPDATE`;
      const scope = await assertFullHomeOperator(tx, hub, { handoffId: String(body.handoffId || ''),
        jti: String(body.jti || ''), credentialVersion: Number(body.credentialVersion) });
      if (process.env.DINODIA_LOGICAL_DEVICES_ENABLED !== 'true') {
        const retained = await tx.nativeDomainOutbox.findUnique({ where: {
          idempotencyKey: `logical-convert:${scope.hubInstallationId}:${String(body.operationId)}` } });
        if (!['reserve', 'commit'].includes(String(body.action)) || !retained
          || retained.homeId !== scope.homeId || !['RESERVED', 'COMPLETE'].includes(retained.state))
          throw new Stage1AuthError(503, 'logical_devices_not_active', 'Only previously reserved conversion can continue');
      }
      return logicalDeviceConversion(tx, scope, { action: String(body.action), operationId: String(body.operationId),
        osDeviceId: String(body.osDeviceId), channels: body.channels, protocolIdentityHash: String(body.protocolIdentityHash || ''),
        digest: String(body.digest || ''), confirmationName: String(body.confirmationName || ''), generation: hub.identity.identityGeneration,
        assignment: body.assignment });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 12000 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return authErrorResponse(error); }
}
