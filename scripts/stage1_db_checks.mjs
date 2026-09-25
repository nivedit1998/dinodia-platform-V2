import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const now = new Date();

async function mustReject(label, operation) {
  try {
    await operation();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} unexpectedly succeeded`) throw error;
    console.log(`[test:stage1-db] rejected as expected: ${label}`);
  }
}

function accountData(label) {
  const id = randomUUID();
  return { displayName: label, username: id, usernameNormalized: id, email: `${id}@invalid.test`, emailNormalized: `${id}@invalid.test`, passwordHash: 'test', emailVerifiedAt: now };
}

async function createHome(label) {
  const identity = await prisma.hubManufacturingIdentity.create({ data: { serialNumber: `${label}-${randomUUID()}`, signingPublicKey: 'signing', encryptionPublicKey: 'encryption', signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID() } });
  const home = await prisma.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
  const hub = await prisma.hubInstallation.create({ data: { homeId: home.id, manufacturingIdentityId: identity.id, serialNumberSnapshot: identity.serialNumber, state: 'PAIRING' } });
  const area = await prisma.area.create({ data: { homeId: home.id, osAreaId: randomUUID(), originalName: `${label} area` } });
  return { identity, home, hub, area };
}

try {
  const [a, b] = await Promise.all([createHome('stage1-a'), createHome('stage1-b')]);
  const accountA = await prisma.customerAccount.create({ data: accountData('Account A') });
  const accountB = await prisma.customerAccount.create({ data: accountData('Account B') });
  const tenantA = await prisma.homeMembership.create({ data: { homeId: a.home.id, customerAccountId: accountA.id, role: 'TENANT' } });
  const tenantB = await prisma.homeMembership.create({ data: { homeId: b.home.id, customerAccountId: accountB.id, role: 'TENANT' } });
  const sameHomeOtherAccount = await prisma.homeMembership.create({ data: { homeId: a.home.id, customerAccountId: accountB.id, role: 'TENANT' } });
  const employee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Stage 1 employee', email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test', role: 'SENIOR_CUSTOMER_SUPPORT' } });
  const otherEmployee = await prisma.companyEmployeeAccount.create({ data: { displayName: 'Other employee', email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test', role: 'INSTALLER' } });
  const work = await prisma.companyOperationalWorkItem.create({ data: { publicReference: randomUUID().slice(0, 20), kind: 'HUB_RECOVERY', state: 'ASSIGNED', homeId: a.home.id, hubInstallationId: a.hub.id, assignedEmployeeId: employee.id, createdByEmployeeId: employee.id, reason: 'Stage 1 test' } });
  const ticket = await prisma.supportTicket.create({ data: { publicReference: `DNO-${randomUUID().slice(0, 12)}`, customerAccountId: accountA.id, homeId: a.home.id, selectedMembershipId: tenantA.id, category: 'Hub or connection', description: 'Stage 1 test', assignedEmployeeId: employee.id } });
  const request = await prisma.supportAccessRequest.create({ data: { ticketId: ticket.id, requestedByEmployeeId: employee.id, homeId: a.home.id, hubInstallationId: a.hub.id, requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantA.id, targetUserId: accountA.id, canonicalAreaIds: [a.area.id], targetIds: [], touchesPropertyInfrastructure: false } });
  console.log('[test:stage1-db] valid ticket and tenant support request succeeded');

  await mustReject('support ticket customer/membership mismatch', () => prisma.supportTicket.create({ data: { publicReference: `DNO-${randomUUID().slice(0, 12)}`, customerAccountId: accountA.id, homeId: a.home.id, selectedMembershipId: sameHomeOtherAccount.id, category: 'Other', description: 'invalid', assignedEmployeeId: employee.id } }));
  await mustReject('support request assigned employee mismatch', () => prisma.supportAccessRequest.create({ data: { ticketId: ticket.id, requestedByEmployeeId: otherEmployee.id, homeId: a.home.id, hubInstallationId: a.hub.id, requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantA.id, targetUserId: accountA.id, canonicalAreaIds: [], targetIds: [] } }));
  await mustReject('support request target account mismatch', () => prisma.supportAccessRequest.create({ data: { ticketId: ticket.id, requestedByEmployeeId: employee.id, homeId: a.home.id, hubInstallationId: a.hub.id, requestedScope: 'TENANT_SCOPE', targetMembershipId: tenantA.id, targetUserId: accountB.id, canonicalAreaIds: [], targetIds: [] } }));
  await mustReject('support session request scope mismatch', () => prisma.supportSession.create({ data: { accessRequestId: request.id, ticketId: ticket.id, employeeId: employee.id, homeId: a.home.id, hubInstallationId: a.hub.id, scope: 'TENANT_SCOPE', areaIds: [], targetUserId: accountB.id, leaseHash: randomUUID(), approvedAt: now, expiresAt: new Date(now.getTime() + 60000) } }));

  const trusted = await prisma.trustedDevice.create({ data: { customerAccountId: accountA.id, deviceInstallationId: randomUUID(), publicKey: 'public', publicKeyThumbprint: randomUUID(), deviceName: 'Test phone' } });
  await mustReject('offline authorisation account mismatch', () => prisma.offlineMembershipAuthorisation.create({ data: { trustedDeviceId: trusted.id, membershipId: tenantB.id, homeId: b.home.id, hubInstallationId: b.hub.id, publicKey: 'public', publicKeyThumbprint: randomUUID(), areaIds: [], scopes: ['tenant:device-command'], policyRevision: 1 } }));
  await mustReject('operator handoff assigned employee mismatch', () => prisma.operatorHandoff.create({ data: { employeeId: otherEmployee.id, workflowId: work.id, homeId: a.home.id, hubInstallationId: a.hub.id, handoffHash: randomUUID(), scope: ['os:admin'], expiresAt: new Date(now.getTime() + 60000) } }));
  await mustReject('invalid credential purpose', () => prisma.hubCredentialVersion.create({ data: { hubInstallationId: a.hub.id, version: 1, purpose: 'legacy-token', tokenHash: randomUUID() } }));
  await mustReject('claim challenge wrong hub', () => prisma.$transaction(async (tx) => {
    const claim = await tx.homeClaimReference.create({ data: { homeId: a.home.id, hubInstallationId: a.hub.id, purpose: 'INITIAL_OWNER', companyQrReferenceHash: randomUUID(), resolverGeneration: 1 } });
    await tx.homeClaimChallenge.create({ data: { claimReferenceId: claim.id, hubInstallationId: b.hub.id, resolverGeneration: 1, nonceHash: randomUUID(), challengeDigest: randomUUID(), expiresAt: new Date(now.getTime() + 60000) } });
  }));

  for (const fixture of [a, b]) {
    await prisma.supportSession.deleteMany({ where: { homeId: fixture.home.id } });
    await prisma.supportAccessRequest.deleteMany({ where: { homeId: fixture.home.id } });
    await prisma.supportTicket.deleteMany({ where: { homeId: fixture.home.id } });
    await prisma.operatorHandoff.deleteMany({ where: { homeId: fixture.home.id } });
    await prisma.companyOperationalWorkItem.deleteMany({ where: { homeId: fixture.home.id } });
    await prisma.homeClaimChallenge.deleteMany({ where: { hubInstallationId: fixture.hub.id } });
    await prisma.homeClaimReference.deleteMany({ where: { hubInstallationId: fixture.hub.id } });
    await prisma.hubInstallation.delete({ where: { id: fixture.hub.id } });
    await prisma.home.delete({ where: { id: fixture.home.id } });
    await prisma.hubManufacturingIdentity.delete({ where: { id: fixture.identity.id } });
  }
  await prisma.customerAccount.delete({ where: { id: accountA.id } });
  await prisma.customerAccount.delete({ where: { id: accountB.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: employee.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: otherEmployee.id } });
  console.log('[test:stage1-db] Stage 1 relational scope guards passed');
} finally {
  await prisma.$disconnect();
}
