// Stage 1 support-access contract harness. Durable tickets, audit rows and
// app routes are introduced by their later contract stage; this class freezes
// the non-negotiable scope, approval, one-use-code and 30-minute lease rules.
import crypto from 'node:crypto';

export const SUPPORT_CODE_TTL_MS = 10 * 60_000;
export const SUPPORT_SESSION_MAX_MS = 30 * 60_000;
const hash = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export type SupportScope = 'TENANT_SCOPE' | 'PROPERTY_SCOPE';

type RequestState = {
  ticketId: string;
  employeeId: number;
  homeId: number;
  hubInstallId: string;
  scope: SupportScope;
  areaIds: string[];
  tenantMembershipId: string | null;
  state: 'REQUESTED' | 'APPROVED' | 'REVOKED' | 'CLOSED';
  approverMembershipId: string | null;
  codeHash: string | null;
  codeExpiresAt: number | null;
  codeConsumedAt: number | null;
  sessionExpiresAt: number | null;
};

export class SupportAccessContractHarness {
  private readonly requests = new Map<string, RequestState>();
  public constructor(private readonly now: () => number = () => Date.now()) {}

  public request(input: Omit<RequestState, 'state' | 'approverMembershipId' | 'codeHash' | 'codeExpiresAt' | 'codeConsumedAt' | 'sessionExpiresAt'>) {
    if (!input.ticketId || !input.employeeId || !input.homeId || !input.hubInstallId) throw new Error('Support request identity is incomplete');
    if (input.scope === 'TENANT_SCOPE' && (!input.tenantMembershipId || input.areaIds.length === 0)) throw new Error('Tenant support scope requires the exact membership and granted areas');
    const state: RequestState = { ...input, areaIds: [...new Set(input.areaIds.map(String))], state: 'REQUESTED', approverMembershipId: null, codeHash: null, codeExpiresAt: null, codeConsumedAt: null, sessionExpiresAt: null };
    this.requests.set(state.ticketId, state);
    return { ticketId: state.ticketId, scope: state.scope, areaIds: state.areaIds };
  }

  public approve(ticketId: string, approverMembershipId: string) {
    const request = this.get(ticketId);
    if (request.state !== 'REQUESTED') throw new Error('Support request is not awaiting approval');
    request.state = 'APPROVED';
    request.approverMembershipId = String(approverMembershipId);
    const code = `DNO-SUPPORT-${crypto.randomBytes(18).toString('base64url')}`;
    request.codeHash = hash(code);
    request.codeExpiresAt = this.now() + SUPPORT_CODE_TTL_MS;
    return { ticketId, code, expiresAt: request.codeExpiresAt, scope: request.scope, areaIds: request.areaIds };
  }

  public redeem(ticketId: string, input: { employeeId: number; code: string }) {
    const request = this.get(ticketId);
    if (request.state !== 'APPROVED' || request.employeeId !== input.employeeId || !request.codeHash || !request.codeExpiresAt || request.codeConsumedAt || this.now() >= request.codeExpiresAt) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hash(input.code)), Buffer.from(request.codeHash))) return null;
    request.codeConsumedAt = this.now();
    const approvalAt = request.codeExpiresAt - SUPPORT_CODE_TTL_MS;
    request.sessionExpiresAt = Math.min(request.codeConsumedAt + SUPPORT_SESSION_MAX_MS, approvalAt + SUPPORT_SESSION_MAX_MS);
    return { ticketId, homeId: request.homeId, hubInstallId: request.hubInstallId, scope: request.scope, areaIds: request.areaIds, tenantMembershipId: request.tenantMembershipId, expiresAt: request.sessionExpiresAt };
  }

  public revoke(ticketId: string) { const request = this.get(ticketId); request.state = 'REVOKED'; request.codeHash = null; request.sessionExpiresAt = null; return { ticketId, state: request.state }; }
  public close(ticketId: string) { const request = this.get(ticketId); request.state = 'CLOSED'; request.codeHash = null; request.sessionExpiresAt = null; return { ticketId, state: request.state }; }
  public status(ticketId: string) { const request = this.get(ticketId); return { ticketId, state: request.state, sessionActive: Boolean(request.sessionExpiresAt && this.now() < request.sessionExpiresAt) }; }
  private get(ticketId: string) { const request = this.requests.get(ticketId); if (!request) throw new Error('Support request not found'); return request; }
}
