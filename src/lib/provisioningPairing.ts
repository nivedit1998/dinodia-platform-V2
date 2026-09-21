// Legacy HA/bootstrap pairing payloads are rejected at the Company Portal
// boundary. Native provisioning uses durableProvisioning.ts and the signed
// hub-agent/v2 pairing routes; there is intentionally no process-local pairing
// registry in the production path.

export function rejectLegacyProvisioningPayload(body: Record<string, unknown>) {
  const forbidden = ['haBaseUrl', 'haCloudUrl', 'haUsername', 'haPassword', 'haLongLivedToken', 'bootstrapSecret'];
  const found = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (found.length) throw new Error(`Legacy provisioning fields are not accepted: ${found.join(', ')}`);
}
