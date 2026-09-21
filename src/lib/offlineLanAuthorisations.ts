import crypto from 'node:crypto';

export type OfflineLanAuthorisation = {
  version: 1;
  homeId: number;
  membershipId: string;
  trustedDeviceId: string;
  publicKey: string;
  areaIds: string[];
  scope: string[];
  policyRevision: number;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};

export function createOfflineLanAuthorisation(input: Omit<OfflineLanAuthorisation, 'version' | 'issuedAt' | 'revokedAt'> & { now?: number }) {
  if (!input.areaIds.length || !input.scope.includes('tenant:device-command')) throw new Error('Offline grants require at least one area and tenant device-command scope');
  return { version: 1 as const, homeId: input.homeId, membershipId: String(input.membershipId), trustedDeviceId: String(input.trustedDeviceId), publicKey: String(input.publicKey), areaIds: [...new Set(input.areaIds.map(String))], scope: [...new Set(input.scope.map(String))], policyRevision: input.policyRevision, issuedAt: input.now ?? Date.now(), expiresAt: input.expiresAt ?? null, revokedAt: null } satisfies OfflineLanAuthorisation;
}

export function offlineGrantFingerprint(grant: OfflineLanAuthorisation) {
  return crypto.createHash('sha256').update(JSON.stringify({ ...grant, publicKey: grant.publicKey }), 'utf8').digest('hex').slice(0, 32);
}
