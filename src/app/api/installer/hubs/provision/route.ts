// Architecture: Stage 1 native hub-pairing contract. This route deliberately
// does not create Home/Hub/QR records; Stage 3 owns durable provisioning.
import { NextRequest, NextResponse } from 'next/server';
import { apiBadRequest, apiFailFromStatus } from '@/lib/apiError';
import { requireCompanyProvisionOperator } from '@/lib/companyPortalGuards';
import { rejectLegacyProvisioningPayload } from '@/lib/provisioningPairing';
import { completeDurableProvisioningAttempt, durableProvisioningClaimState, redeemDurableProvisioningPresentation } from '@/lib/durableProvisioning';
import { checkRateLimit } from '@/lib/rateLimit';


function parseQrOrCode(value: unknown) {
  const raw = String(value || '').trim();
  const match = raw.match(/^dinodia-pairing-v1:([^:]+):(.+)$/i);
  return match ? { pairingId: match[1], code: match[2] } : { pairingId: '', code: raw };
}

export async function POST(req: NextRequest) {
  const operator = await requireCompanyProvisionOperator(req);
  if (operator instanceof NextResponse) return operator;
  if (!(await checkRateLimit(`hub-provision-pairing:${operator.userId}`, { maxRequests: 5, windowMs: 15 * 60_000 }))) return apiFailFromStatus(429, 'Too many hub pairing attempts. Please wait before trying again.');
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiBadRequest('Invalid request body.');
  if (body.action === 'complete_installation') {
    const pairingId = typeof body.pairingId === 'string' ? body.pairingId : '';
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
    const completed = await completeDurableProvisioningAttempt({ attemptId: pairingId, operatorId: operator.userId, workflowId, role: operator.role });
    if (!completed.ok) return apiFailFromStatus(409, 'The pairing must be redeemed before installation can be completed.');
    return NextResponse.json({ ok: true, phase: 'INSTALLATION_COMPLETE', homeQr: completed.homeQrReference }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  }
  try { rejectLegacyProvisioningPayload(body); } catch (error) { return apiFailFromStatus(400, (error as Error).message); }
  const parsed = parseQrOrCode(body.pairingCode || body.qrPayload || body.code);
  if (!parsed.code || parsed.code.length > 256) return apiBadRequest('Enter the short-lived hub-generated pairing code or scan its QR.');
  const workflowId = typeof body.installationWorkflowId === 'string' ? body.installationWorkflowId.trim() : '';
  const redeemed = parsed.pairingId
    ? await redeemDurableProvisioningPresentation({ attemptId: parsed.pairingId, code: parsed.code, operatorId: operator.userId, workflowId })
    : { ok: false as const, errorCode: 'pairing_not_found' as const };
  if (!redeemed.ok) return apiFailFromStatus(redeemed.errorCode === 'pairing_expired' ? 410 : 409, 'This pairing presentation was not accepted. Generate a new code on the hub and try again.');
  const claim = await durableProvisioningClaimState(redeemed.attemptId);
  return NextResponse.json({ ok: true, mode: 'durable-stage1-contract', phase: 'HUB_PROOF_ACCEPTED', pairingId: redeemed.pairingId, serial: redeemed.serial, baseUrl: redeemed.baseUrl, cloudUrl: null, machineCredential: 'delivered-only-to-proven-hub', homeQr: claim.ok ? claim.homeQrReference : null, claimState: claim.ok ? { pendingInstallation: claim.pendingInstallation, state: claim.state } : null, operator: { id: operator.userId, role: operator.role } }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
}
