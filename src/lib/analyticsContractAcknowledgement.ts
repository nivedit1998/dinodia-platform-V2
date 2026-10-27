// Pure decision helper for a future generation-bound acknowledgement. It is
// deliberately not wired to assignment or sync until persistence, atomic
// invalidation, exact nonce handling and rollout are implemented and reviewed.
export type AnalyticsContractAcknowledgement = {
  homeId: string;
  hubInstallationId: string;
  manufacturingIdentityId: string;
  identityGeneration: number;
  analyticsContractVersion: number;
  appliedCloudRevision: number;
  receivedAt: Date;
  invalidatedAt: Date | null;
};

export type CurrentAnalyticsAuthority = {
  homeId: string;
  hubInstallationId: string;
  manufacturingIdentityId: string;
  identityGeneration: number;
  identityActive: boolean;
  installationActive: boolean;
  currentCloudRevision: number;
};

const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\u0000-\u001f\u007f]/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2_147_483_647;

/** Caller must read and lock authority and acknowledgement in the same
 * transaction as assignment, and invalidate before a managed downgrade.
 * An empty signed sync and these checks alone are not remote attestation. */
export function hasCurrentAnalyticsContract(
  proof: AnalyticsContractAcknowledgement | null,
  current: CurrentAnalyticsAuthority,
  expectedVersion: number,
  now: Date,
  maxAgeMs: number,
): boolean {
  if (!proof || !current || !id(current.homeId) || !id(current.hubInstallationId) || !id(current.manufacturingIdentityId)
    || !count(current.identityGeneration) || current.identityGeneration < 1 || !count(current.currentCloudRevision)
    || current.identityActive !== true || current.installationActive !== true
    || !count(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
    || !(now instanceof Date) || !Number.isFinite(now.getTime()) || !(proof.receivedAt instanceof Date)
    || !Number.isFinite(proof.receivedAt.getTime()) || proof.invalidatedAt !== null) return false;
  const age = now.getTime() - proof.receivedAt.getTime();
  return proof.homeId === current.homeId && proof.hubInstallationId === current.hubInstallationId
    && proof.manufacturingIdentityId === current.manufacturingIdentityId
    && proof.identityGeneration === current.identityGeneration && proof.analyticsContractVersion === expectedVersion
    && proof.appliedCloudRevision === current.currentCloudRevision && age >= 0 && age <= maxAgeMs;
}
