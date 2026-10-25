import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateHub } from '@/lib/stage1HubAuth';
import { authErrorResponse, Stage1AuthError } from '@/lib/stage1Auth';
import { assertFullHomeOperator } from '@/lib/fullHomeOperatorAuthority';
import { previewAreaDeletion, reserveAreaDeletion, commitAreaDeletion, finishAreaDeletion } from '@/lib/areaDeletion';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const hub = await authenticateHub(request, raw, { maxBodyBytes: 64 * 1024 });
    if (process.env.DINODIA_LOGICAL_DEVICES_ENABLED !== 'true')
      throw new Stage1AuthError(503, 'logical_devices_not_active', 'Logical device management is not active');
    const body = hub.body;
    const allowed = new Set(['operationId', 'action', 'areaId', 'handoffId', 'jti', 'credentialVersion', 'digest', 'localFenceDigest', 'confirmationName']);
    if (Object.keys(body).some(key => !allowed.has(key)))
      throw new Stage1AuthError(400, 'area_delete_request_invalid', 'The deletion request has unsupported fields');
    if (!/^[0-9a-f-]{36}$/i.test(String(body.operationId || '')) || !['preview', 'reserve', 'commit', 'finish'].includes(String(body.action)))
      throw new Stage1AuthError(400, 'area_delete_request_invalid', 'The deletion request is invalid');
    const action = String(body.action), operationId = String(body.operationId);
    const result = await prisma.$transaction(async tx => {
      const hubScope = { homeId: hub.installation.homeId, hubInstallationId: hub.installation.id };
      if (action === 'finish') return finishAreaDeletion(tx, hubScope, { operationId, localFenceDigest: String(body.localFenceDigest || '') });
      await tx.$queryRaw`SELECT id FROM "Home" WHERE id = ${hubScope.homeId}::uuid FOR UPDATE`;
      const scope = await assertFullHomeOperator(tx, hub, { handoffId: String(body.handoffId || ''),
        jti: String(body.jti || ''), credentialVersion: Number(body.credentialVersion) });
      if (action === 'preview') {
        if (!/^[0-9a-f-]{36}$/i.test(String(body.areaId || ''))) throw new Stage1AuthError(400, 'area_delete_area_invalid', 'Select an exact Area');
        return previewAreaDeletion(tx, scope, { operationId, areaId: String(body.areaId) });
      }
      if (action === 'reserve') return reserveAreaDeletion(tx, scope, { operationId,
        digest: String(body.digest || ''), confirmationName: String(body.confirmationName || '') });
      return commitAreaDeletion(tx, scope, { operationId, digest: String(body.digest || ''),
        localFenceDigest: String(body.localFenceDigest || ''), confirmationName: String(body.confirmationName || '') });
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 12000 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return authErrorResponse(error); }
}
