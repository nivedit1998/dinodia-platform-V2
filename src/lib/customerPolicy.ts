import { prisma } from './prisma';
import { assertClaimSessionCurrent, type ClaimTransaction } from './stage1ClaimContract';
import { Stage1AuthError, type CustomerAccountSessionPrincipal } from './stage1Auth';
export { currentCustomerPolicy } from './customerPolicyConfig';
import { currentCustomerPolicy } from './customerPolicyConfig';

export async function customerPolicyDecision(accountId: string) {
  const policy = currentCustomerPolicy();
  if (!policy) return { nextAction: 'POLICY_UNAVAILABLE' as const, accepted: false, policy: null };
  const acceptance = await prisma.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: accountId, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } });
  return { nextAction: acceptance ? 'CONTINUE' as const : 'ACCEPT_POLICY' as const, accepted: Boolean(acceptance), policy };
}

export async function acceptCurrentCustomerPolicy(input: {
  principal: CustomerAccountSessionPrincipal;
  version: string;
  contentSha256: string;
  accepted: true;
}) {
  return prisma.$transaction(async (tx) => {
    await assertClaimSessionCurrent(tx as ClaimTransaction, input.principal);
    const policy = currentCustomerPolicy();
    if (!policy) throw new Stage1AuthError(503, 'policy_unavailable', 'The approved customer policy is not configured');
    if (input.version !== policy.version || input.contentSha256 !== policy.contentSha256 || input.accepted !== true) {
      throw new Stage1AuthError(409, 'policy_stale', 'Review the current customer policy before accepting');
    }
    const existing = await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: { customerAccountId: input.principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } }, select: { id: true } });
    if (existing) return { policyVersion: policy.version, contentSha256: policy.contentSha256, idempotentReplay: true };
    await tx.policyAcceptance.create({ data: { customerAccountId: input.principal.id, policyKind: 'DINODIA_NATIVE', policyVersion: policy.version } });
    return { policyVersion: policy.version, contentSha256: policy.contentSha256, idempotentReplay: false };
  }, { isolationLevel: 'Serializable' });
}
