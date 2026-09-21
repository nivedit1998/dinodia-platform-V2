import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  canCommandDevice,
  canReadDevice,
  canSelfRemoveMembership,
  effectiveAreaName,
  isAssignedWorkAuthorized,
  isClaimPresentationShape,
  isCurrentClaimChallenge,
  qualifiesReservationExtension,
  reservationDeadline,
} from '../src/lib/foundationContracts.mjs';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const now = new Date();

async function mustReject(label, operation) {
  try {
    await operation();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} unexpectedly succeeded`) throw error;
    console.log(`[test:foundation:invariants] rejected as expected: ${label}`);
  }
}

async function createValidActiveHome(tx) {
  const identity = await tx.hubManufacturingIdentity.create({
    data: {
      serialNumber: `test-${randomUUID()}`,
      signingPublicKey: 'test-signing-public-key',
      encryptionPublicKey: 'test-encryption-public-key',
      signingKeyFingerprint: randomUUID(),
      encryptionKeyFingerprint: randomUUID(),
    },
  });
  const home = await tx.home.create({
    data: {
      addressLine1: 'Test address', city: 'Test city', postcode: 'TST 1AA', country: 'GB', timezone: 'Europe/London',
      addressStatus: 'VERIFIED', lifecycle: 'ACTIVE', installationStatus: 'COMPLETE',
    },
  });
  const hub = await tx.hubInstallation.create({
    data: {
      homeId: home.id, manufacturingIdentityId: identity.id, serialNumberSnapshot: identity.serialNumber,
      state: 'ACTIVE', cloudUrl: 'https://test.example.invalid', cloudUrlVerifiedAt: now, remoteChallengeAt: now, remoteVerificationAt: now,
    },
  });
  const area = await tx.area.create({ data: { homeId: home.id, osAreaId: randomUUID(), originalName: 'Test area' } });
  return { identity, home, hub, area };
}

try {
  await mustReject('active Home without area and verified CloudURL', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.home.create({
        data: { addressLine1: 'Test', city: 'Test', postcode: 'TST 1AA', country: 'GB', timezone: 'Europe/London', addressStatus: 'VERIFIED', lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' },
      });
    });
  });

  const valid = await prisma.$transaction((tx) => createValidActiveHome(tx));
  await prisma.home.update({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' }, where: { id: valid.home.id } });
  await prisma.area.delete({ where: { id: valid.area.id } });
  await prisma.hubInstallation.delete({ where: { id: valid.hub.id } });
  await prisma.home.delete({ where: { id: valid.home.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: valid.identity.id } });
  console.log('[test:foundation:invariants] valid active Home supports zero devices and cleanup');

  const isolationFixtures = await prisma.$transaction(async (tx) => {
    const identityA = await tx.hubManufacturingIdentity.create({ data: {
      serialNumber: `isolation-a-${randomUUID()}`,
      signingPublicKey: 'signing-a', encryptionPublicKey: 'encryption-a',
      signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID(),
    } });
    const identityB = await tx.hubManufacturingIdentity.create({ data: {
      serialNumber: `isolation-b-${randomUUID()}`,
      signingPublicKey: 'signing-b', encryptionPublicKey: 'encryption-b',
      signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID(),
    } });
    const homeA = await tx.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
    const homeB = await tx.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
    const hubA = await tx.hubInstallation.create({ data: { homeId: homeA.id, manufacturingIdentityId: identityA.id, serialNumberSnapshot: identityA.serialNumber, state: 'PAIRING' } });
    const hubB = await tx.hubInstallation.create({ data: { homeId: homeB.id, manufacturingIdentityId: identityB.id, serialNumberSnapshot: identityB.serialNumber, state: 'PAIRING' } });
    const areaA = await tx.area.create({ data: { homeId: homeA.id, osAreaId: randomUUID(), originalName: 'Area A' } });
    const areaB = await tx.area.create({ data: { homeId: homeB.id, osAreaId: randomUUID(), originalName: 'Area B' } });
    const accountA = await tx.customerAccount.create({ data: { displayName: 'Account A', username: randomUUID(), usernameNormalized: randomUUID(), email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test', emailVerifiedAt: now } });
    const accountB = await tx.customerAccount.create({ data: { displayName: 'Account B', username: randomUUID(), usernameNormalized: randomUUID(), email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test', emailVerifiedAt: now } });
    const tenantA = await tx.homeMembership.create({ data: { homeId: homeA.id, customerAccountId: accountA.id, role: 'TENANT' } });
    const tenantB = await tx.homeMembership.create({ data: { homeId: homeB.id, customerAccountId: accountB.id, role: 'TENANT' } });
    const employee = await tx.companyEmployeeAccount.create({ data: { displayName: 'Installer', email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test', role: 'INSTALLER' } });
    const propertyDeviceA = await tx.nativeDevice.create({ data: { homeId: homeA.id, hubInstallationId: hubA.id, osDeviceId: randomUUID(), originalName: 'Property A', technicalLabel: 'light', analyticsCategory: 'LIGHT', managementClass: 'PROPERTY_DEVICE', deviceType: 'light' } });
    const qrA = await tx.areaQrCredential.create({ data: { areaId: areaA.id, resolverHash: randomUUID() } });
    return { identityA, identityB, homeA, homeB, hubA, hubB, areaA, areaB, accountA, accountB, tenantA, tenantB, employee, propertyDeviceA, qrA };
  });

  await prisma.$transaction(async (tx) => {
    await tx.tenantAreaGrant.create({ data: { membershipId: isolationFixtures.tenantA.id, areaId: isolationFixtures.areaA.id, homeId: isolationFixtures.homeA.id } });
  });
  console.log('[test:foundation:invariants] same-home tenant area grant succeeds');

  await prisma.$transaction(async (tx) => {
    const tenantDevice = await tx.nativeDevice.create({ data: {
      homeId: isolationFixtures.homeA.id,
      hubInstallationId: isolationFixtures.hubA.id,
      osDeviceId: randomUUID(),
      originalName: 'Tenant-owned test device',
      technicalLabel: 'tenant_device',
      analyticsCategory: 'NONE',
      managementClass: 'TENANT_DEVICE',
      ownerMembershipId: isolationFixtures.tenantA.id,
      deviceType: 'sensor',
      lifecycle: 'INSTALLED',
      installedAt: now,
    } });
    await tx.deviceAreaAssignment.create({ data: {
      deviceId: tenantDevice.id,
      areaId: isolationFixtures.areaA.id,
      homeId: isolationFixtures.homeA.id,
      source: 'foundation-test',
    } });
  });
  console.log('[test:foundation:invariants] valid installed tenant device requires and accepts one current area assignment');

  await prisma.$transaction(async (tx) => {
    const tenantInvitation = await tx.membershipInvitation.create({ data: {
      homeId: isolationFixtures.homeA.id,
      inviterMembershipId: isolationFixtures.tenantA.id,
      targetEmail: 'valid-tenant@invalid.test',
      targetEmailNormalized: 'valid-tenant@invalid.test',
      role: 'TENANT',
      tokenHash: randomUUID(),
      expiresAt: new Date(now.getTime() + 86400000),
    } });
    await tx.membershipInvitationArea.create({ data: {
      invitationId: tenantInvitation.id,
      areaId: isolationFixtures.areaA.id,
      homeId: isolationFixtures.homeA.id,
    } });
    await tx.membershipInvitation.create({ data: {
      homeId: isolationFixtures.homeA.id,
      inviterMembershipId: isolationFixtures.tenantA.id,
      targetEmail: 'valid-manager@invalid.test',
      targetEmailNormalized: 'valid-manager@invalid.test',
      role: 'PROPERTY_MANAGER',
      tokenHash: randomUUID(),
      expiresAt: new Date(now.getTime() + 86400000),
    } });
    await tx.areaAccessRequest.create({ data: {
      areaQrCredentialId: isolationFixtures.qrA.id,
      areaId: isolationFixtures.areaA.id,
      homeId: isolationFixtures.homeA.id,
      requesterAccountId: isolationFixtures.accountA.id,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + 7 * 86400000),
    } });
  });
  console.log('[test:foundation:invariants] valid tenant/manager invitations and verified room access request succeed');

  await mustReject('cross-home tenant area grant', async () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "TenantAreaGrant" ("id", "membershipId", "areaId", "homeId", "policyRevision", "grantedAt", "createdAt", "updatedAt") VALUES (${randomUUID()}::uuid, ${isolationFixtures.tenantA.id}::uuid, ${isolationFixtures.areaB.id}::uuid, ${isolationFixtures.homeA.id}::uuid, 1, NOW(), NOW(), NOW())`;
  }));
  await mustReject('cross-home tenant-device owner', async () => prisma.$transaction(async (tx) => {
    await tx.nativeDevice.create({ data: { homeId: isolationFixtures.homeA.id, hubInstallationId: isolationFixtures.hubA.id, osDeviceId: randomUUID(), originalName: 'Cross owner', technicalLabel: 'tenant_device', analyticsCategory: 'NONE', managementClass: 'TENANT_DEVICE', ownerMembershipId: isolationFixtures.tenantB.id, deviceType: 'sensor' } });
  }));
  await mustReject('cross-home device area assignment', async () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DeviceAreaAssignment" ("id", "deviceId", "areaId", "homeId", "validFrom", "source", "createdAt") VALUES (${randomUUID()}::uuid, ${isolationFixtures.propertyDeviceA.id}::uuid, ${isolationFixtures.areaB.id}::uuid, ${isolationFixtures.homeB.id}::uuid, NOW(), 'test', NOW())`;
  }));
  await mustReject('cross-home invitation inviter', async () => prisma.$transaction(async (tx) => {
    await tx.membershipInvitation.create({ data: { homeId: isolationFixtures.homeB.id, inviterMembershipId: isolationFixtures.tenantA.id, targetEmail: 'manager@invalid.test', targetEmailNormalized: 'manager@invalid.test', role: 'PROPERTY_MANAGER', tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 86400000) } });
  }));
  await mustReject('cross-home invitation area', async () => prisma.$transaction(async (tx) => {
    const invitationId = randomUUID();
    await tx.$executeRaw`INSERT INTO "MembershipInvitation" ("id", "homeId", "inviterMembershipId", "targetEmail", "targetEmailNormalized", "role", "state", "tokenHash", "expiresAt", "createdAt", "updatedAt") VALUES (${invitationId}::uuid, ${isolationFixtures.homeA.id}::uuid, ${isolationFixtures.tenantA.id}::uuid, 'tenant@invalid.test', 'tenant@invalid.test', 'TENANT'::"InvitationRole", 'PENDING'::"InvitationState", ${randomUUID()}, NOW() + INTERVAL '1 day', NOW(), NOW())`;
    await tx.$executeRaw`INSERT INTO "MembershipInvitationArea" ("id", "invitationId", "areaId", "homeId") VALUES (${randomUUID()}::uuid, ${invitationId}::uuid, ${isolationFixtures.areaB.id}::uuid, ${isolationFixtures.homeB.id}::uuid)`;
  }));
  await mustReject('cross-home area access request', async () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "AreaAccessRequest" ("id", "areaQrCredentialId", "areaId", "homeId", "requesterAccountId", "status", "expiresAt", "createdAt", "updatedAt") VALUES (${randomUUID()}::uuid, ${isolationFixtures.qrA.id}::uuid, ${isolationFixtures.areaB.id}::uuid, ${isolationFixtures.homeA.id}::uuid, ${isolationFixtures.accountA.id}::uuid, 'PENDING'::"AreaAccessRequestStatus", NOW() + INTERVAL '7 days', NOW(), NOW())`;
  }));
  await mustReject('cross-home claim reference', async () => prisma.$transaction(async (tx) => {
    await tx.homeClaimReference.create({ data: { homeId: isolationFixtures.homeA.id, hubInstallationId: isolationFixtures.hubB.id, purpose: 'INITIAL_OWNER', companyQrReferenceHash: randomUUID(), resolverGeneration: 1 } });
  }));
  await mustReject('cross-home operational work item', async () => prisma.$transaction(async (tx) => {
    await tx.companyOperationalWorkItem.create({ data: { publicReference: randomUUID().slice(0, 20), kind: 'HUB_RECOVERY', state: 'ASSIGNED', homeId: isolationFixtures.homeA.id, hubInstallationId: isolationFixtures.hubB.id, assignedEmployeeId: isolationFixtures.employee.id, createdByEmployeeId: isolationFixtures.employee.id, reason: 'cross-home test' } });
  }));
  await mustReject('cross-home step-up membership', async () => prisma.$transaction(async (tx) => {
    await tx.stepUpAuthorization.create({ data: { customerAccountId: isolationFixtures.accountA.id, homeId: isolationFixtures.homeA.id, membershipId: isolationFixtures.tenantB.id, operationKind: 'test', targetDigest: 'target', normalizedValueDigest: 'value', policyRevision: 1, nonceHash: randomUUID(), expiresAt: new Date(now.getTime() + 60000) } });
  }));

  await mustReject('tenant invitation without an area', async () => prisma.$transaction(async (tx) => {
    await tx.membershipInvitation.create({ data: { homeId: isolationFixtures.homeA.id, inviterMembershipId: isolationFixtures.tenantA.id, targetEmail: 'empty@invalid.test', targetEmailNormalized: 'empty@invalid.test', role: 'TENANT', tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 86400000) } });
  }));

  const generationFixture = await prisma.hubManufacturingIdentity.create({ data: {
    serialNumber: `generation-${randomUUID()}`, signingPublicKey: 'signing-1', encryptionPublicKey: 'encryption-1', signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID(), status: 'ACTIVE', identityGeneration: 1,
  } });
  await prisma.hubManufacturingIdentity.update({ where: { id: generationFixture.id }, data: { status: 'REVOKED', revokedAt: now } });
  const generationTwo = await prisma.hubManufacturingIdentity.create({ data: {
    serialNumber: generationFixture.serialNumber, signingPublicKey: 'signing-2', encryptionPublicKey: 'encryption-2', signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID(), status: 'ACTIVE', identityGeneration: 2,
  } });
  await mustReject('two active identity generations', async () => prisma.hubManufacturingIdentity.create({ data: {
    serialNumber: generationFixture.serialNumber, signingPublicKey: 'signing-3', encryptionPublicKey: 'encryption-3', signingKeyFingerprint: randomUUID(), encryptionKeyFingerprint: randomUUID(), status: 'ACTIVE', identityGeneration: 3,
  } }));
  await prisma.hubManufacturingIdentity.delete({ where: { id: generationTwo.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: generationFixture.id } });
  console.log('[test:foundation:invariants] cross-home isolation, invitation rules and identity generations passed');

  await prisma.hubInstallation.delete({ where: { id: isolationFixtures.hubA.id } });
  await prisma.hubInstallation.delete({ where: { id: isolationFixtures.hubB.id } });
  await prisma.areaAccessRequest.deleteMany({ where: { homeId: isolationFixtures.homeA.id } });
  await prisma.areaAccessRequest.deleteMany({ where: { homeId: isolationFixtures.homeB.id } });
  await prisma.membershipInvitation.deleteMany({ where: { homeId: isolationFixtures.homeA.id } });
  await prisma.membershipInvitation.deleteMany({ where: { homeId: isolationFixtures.homeB.id } });
  await prisma.home.delete({ where: { id: isolationFixtures.homeA.id } });
  await prisma.home.delete({ where: { id: isolationFixtures.homeB.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: isolationFixtures.identityA.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: isolationFixtures.identityB.id } });
  await prisma.customerAccount.delete({ where: { id: isolationFixtures.accountA.id } });
  await prisma.customerAccount.delete({ where: { id: isolationFixtures.accountB.id } });
  await prisma.companyEmployeeAccount.delete({ where: { id: isolationFixtures.employee.id } });
  console.log('[test:foundation:invariants] isolation fixtures cleaned up');

  await mustReject('active Home cannot delete its last Area', async () => {
    await prisma.$transaction(async (tx) => {
      const validHome = await createValidActiveHome(tx);
      await tx.area.delete({ where: { id: validHome.area.id } });
    });
  });

  await mustReject('two active OWNER memberships are rejected', async () => {
    await prisma.$transaction(async (tx) => {
      const validHome = await createValidActiveHome(tx);
      const accountOne = await tx.customerAccount.create({ data: { displayName: 'One', username: randomUUID(), usernameNormalized: randomUUID(), email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test' } });
      const accountTwo = await tx.customerAccount.create({ data: { displayName: 'Two', username: randomUUID(), usernameNormalized: randomUUID(), email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test' } });
      await tx.homeMembership.create({ data: { homeId: validHome.home.id, customerAccountId: accountOne.id, role: 'OWNER' } });
      await tx.homeMembership.create({ data: { homeId: validHome.home.id, customerAccountId: accountTwo.id, role: 'OWNER' } });
    });
  });

  await mustReject('PROPERTY_DEVICE cannot carry tenant ownership', async () => {
    await prisma.$transaction(async (tx) => {
      const validHome = await createValidActiveHome(tx);
      const account = await tx.customerAccount.create({ data: { displayName: 'Tenant', username: randomUUID(), usernameNormalized: randomUUID(), email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test' } });
      const membership = await tx.homeMembership.create({ data: { homeId: validHome.home.id, customerAccountId: account.id, role: 'TENANT' } });
      await tx.nativeDevice.create({ data: { homeId: validHome.home.id, hubInstallationId: validHome.hub.id, osDeviceId: randomUUID(), originalName: 'Bad device', technicalLabel: 'light', analyticsCategory: 'LIGHT', managementClass: 'PROPERTY_DEVICE', ownerMembershipId: membership.id, deviceType: 'light' } });
    });
  });

  await mustReject('initial claim cannot contain transfer-only fields', async () => {
    await prisma.$transaction(async (tx) => {
      const validHome = await createValidActiveHome(tx);
      await tx.homeClaimReference.create({ data: { homeId: validHome.home.id, hubInstallationId: validHome.hub.id, purpose: 'INITIAL_OWNER', companyQrReferenceHash: randomUUID(), transferCodeHash: 'not-allowed', resolverGeneration: 1 } });
    });
  });

  const preAddressFixture = await prisma.$transaction(async (tx) => {
    const identity = await tx.hubManufacturingIdentity.create({
      data: {
        serialNumber: `pre-address-${randomUUID()}`,
        signingPublicKey: 'signing',
        encryptionPublicKey: 'encryption',
        signingKeyFingerprint: randomUUID(),
        encryptionKeyFingerprint: randomUUID(),
      },
    });
    const home = await tx.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
    const hub = await tx.hubInstallation.create({
      data: {
        homeId: home.id,
        manufacturingIdentityId: identity.id,
        serialNumberSnapshot: identity.serialNumber,
        state: 'PAIRING',
      },
    });
    if (!home.id || !hub.id) throw new Error('trusted pre-address registration did not persist');
    return { identityId: identity.id, homeId: home.id, hubId: hub.id };
  });
  console.log('[test:foundation:invariants] trusted Home/hub registration works before address, owner and device');
  await prisma.hubInstallation.delete({ where: { id: preAddressFixture.hubId } });
  await prisma.home.delete({ where: { id: preAddressFixture.homeId } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: preAddressFixture.identityId } });

  await mustReject('installation completion without a verified CloudURL', async () => {
    await prisma.$transaction(async (tx) => {
      const identity = await tx.hubManufacturingIdentity.create({
        data: {
          serialNumber: `no-cloud-${randomUUID()}`,
          signingPublicKey: 'signing',
          encryptionPublicKey: 'encryption',
          signingKeyFingerprint: randomUUID(),
          encryptionKeyFingerprint: randomUUID(),
        },
      });
      const home = await tx.home.create({
        data: {
          addressLine1: 'Test', city: 'Test', postcode: 'TST 1AA', country: 'GB', timezone: 'Europe/London',
          addressStatus: 'VERIFIED', lifecycle: 'INSTALLING', installationStatus: 'IN_PROGRESS',
        },
      });
      const hub = await tx.hubInstallation.create({
        data: {
          homeId: home.id, manufacturingIdentityId: identity.id, serialNumberSnapshot: identity.serialNumber, state: 'PROVISIONED',
        },
      });
      await tx.area.create({ data: { homeId: home.id, osAreaId: randomUUID(), originalName: 'Area' } });
      await tx.home.update({ where: { id: home.id }, data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } });
      void hub;
    });
  });

  const activationFixture = await prisma.$transaction(async (tx) => {
    const identity = await tx.hubManufacturingIdentity.create({
      data: {
        serialNumber: `activation-${randomUUID()}`,
        signingPublicKey: 'signing',
        encryptionPublicKey: 'encryption',
        signingKeyFingerprint: randomUUID(),
        encryptionKeyFingerprint: randomUUID(),
      },
    });
    const home = await tx.home.create({ data: { lifecycle: 'CLAIMABLE', installationStatus: 'COMPLETE' } });
    const hub = await tx.hubInstallation.create({
      data: {
        homeId: home.id,
        manufacturingIdentityId: identity.id,
        serialNumberSnapshot: identity.serialNumber,
        state: 'ACTIVE',
        cloudUrl: 'https://activation.example.invalid',
        cloudUrlVerifiedAt: now,
        remoteChallengeAt: now,
        remoteVerificationAt: now,
      },
    });
    await tx.area.create({ data: { homeId: home.id, osAreaId: randomUUID(), originalName: 'Accepted area' } });
    const claim = await tx.homeClaimReference.create({
      data: {
        homeId: home.id,
        hubInstallationId: hub.id,
        purpose: 'INITIAL_OWNER',
        companyQrReferenceHash: randomUUID(),
        resolverGeneration: 1,
      },
    });
    const account = await tx.customerAccount.create({
      data: {
        displayName: 'Pending owner', username: randomUUID(), usernameNormalized: randomUUID(),
        email: `${randomUUID()}@invalid.test`, emailNormalized: `${randomUUID()}@invalid.test`, passwordHash: 'test',
        emailVerifiedAt: now,
      },
    });
    const reservation = await tx.homeClaimReservation.create({
      data: {
        claimReferenceId: claim.id,
        customerAccountId: account.id,
        expiresAt: reservationDeadline(now),
      },
    });
    const pending = await tx.pendingHomeSetup.create({
      data: {
        claimReferenceId: claim.id,
        reservationId: reservation.id,
        customerAccountId: account.id,
        state: 'READY_TO_ACTIVATE',
        addressLine1: 'Accepted address', city: 'Accepted city', postcode: 'ACC 1AA', country: 'GB',
        proposedTimezone: 'Europe/London', requiredStep: 'INSTALLATION', setupRevision: 1,
      },
    });
    return { home, hub, claim, account, reservation, pending };
  });

  await prisma.$transaction(async (tx) => {
    const pending = await tx.pendingHomeSetup.findUniqueOrThrow({ where: { id: activationFixture.pending.id } });
    const updatedHome = await tx.home.update({
      where: { id: activationFixture.home.id },
      data: {
        addressLine1: pending.addressLine1,
        city: pending.city,
        postcode: pending.postcode,
        country: pending.country,
        timezone: pending.proposedTimezone,
        addressStatus: 'VERIFIED',
        lifecycle: 'ACTIVE',
        installationStatus: 'COMPLETE',
      },
    });
    await tx.homeMembership.create({ data: { homeId: updatedHome.id, customerAccountId: pending.customerAccountId, role: 'OWNER' } });
    await tx.homeClaimReference.update({ where: { id: pending.claimReferenceId }, data: { state: 'CONSUMED', claimedAccountId: pending.customerAccountId, consumedAt: now } });
    await tx.homeClaimReservation.update({ where: { id: pending.reservationId }, data: { state: 'CONVERTED_TO_PENDING_INSTALLATION' } });
    await tx.pendingHomeSetup.update({ where: { id: pending.id }, data: { state: 'ACTIVATED', completedAt: now } });
  });
  const activated = await prisma.home.findUniqueOrThrow({ where: { id: activationFixture.home.id }, include: { memberships: true } });
  if (activated.addressLine1 !== 'Accepted address' || activated.memberships.length !== 1 || activated.memberships[0].role !== 'OWNER') {
    throw new Error('pending setup activation did not atomically create the owner state');
  }
  await prisma.pendingHomeSetup.delete({ where: { id: activationFixture.pending.id } });
  await prisma.homeClaimReservation.delete({ where: { id: activationFixture.reservation.id } });
  await prisma.homeClaimReference.delete({ where: { id: activationFixture.claim.id } });
  await prisma.home.update({ where: { id: activationFixture.home.id }, data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
  await prisma.hubInstallation.delete({ where: { id: activationFixture.hub.id } });
  await prisma.home.delete({ where: { id: activationFixture.home.id } });
  await prisma.hubManufacturingIdentity.delete({ where: { id: activationFixture.hub.manufacturingIdentityId } });
  await prisma.customerAccount.delete({ where: { id: activationFixture.account.id } });
  console.log('[test:foundation:invariants] pending setup activation copies accepted data, creates one owner and consumes the claim');

  const nowForContract = new Date('2026-09-21T12:00:00.000Z');
  if (!isClaimPresentationShape({ purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: 1, transferCodeHash: null })) throw new Error('initial claim presentation shape rejected');
  if (isClaimPresentationShape({ purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: 1, transferCodeHash: 'transfer-only' })) throw new Error('initial claim accepted transfer presentation');
  if (!isClaimPresentationShape({ purpose: 'OWNERSHIP_TRANSFER', state: 'AVAILABLE', resolverGeneration: 1, transferCodeHash: 'transfer' })) throw new Error('transfer claim presentation shape rejected');
  if (!isCurrentClaimChallenge(
    { purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: 3, transferCodeHash: null },
    { resolverGeneration: 3, expiresAt: new Date(nowForContract.getTime() + 1000), consumedAt: null, revokedAt: null, signedResponseDigest: 'signed' },
    nowForContract,
  )) throw new Error('current live claim challenge was rejected');
  if (isCurrentClaimChallenge(
    { purpose: 'INITIAL_OWNER', state: 'AVAILABLE', resolverGeneration: 2, transferCodeHash: null },
    { resolverGeneration: 3, expiresAt: new Date(nowForContract.getTime() + 1000), consumedAt: null, revokedAt: null, signedResponseDigest: 'signed' },
    nowForContract,
  )) throw new Error('stale resolver generation was accepted');
  console.log('[test:foundation:invariants] claim purposes and current resolver challenges are distinct and generation-bound');

  const deadline = reservationDeadline(nowForContract);
  if (deadline.getTime() !== nowForContract.getTime() + 30 * 60 * 1000) throw new Error('reservation deadline is not exactly 30 minutes');
  if (!qualifiesReservationExtension('ACTIVE', 2, 3, true) || qualifiesReservationExtension('ACTIVE', 2, 2, true) || qualifiesReservationExtension('ACTIVE', 2, 3, false)) {
    throw new Error('reservation extension rules do not require a newly persisted setup mutation');
  }
  console.log('[test:foundation:invariants] claim reservation has exact 30-minute and persisted-mutation rules');

  const areaA = { originalName: 'Room 1', overrideName: 'Bedroom' };
  const areaB = { originalName: 'Room 2', overrideName: 'Bedroom' };
  if (effectiveAreaName(areaA) !== 'Bedroom' || effectiveAreaName(areaA) !== effectiveAreaName(areaB)) throw new Error('effective area naming failed');
  const membership = { id: 'tenant-a', homeId: 'home-a', role: 'TENANT', status: 'ACTIVE' };
  const otherMembership = { id: 'tenant-b', homeId: 'home-a', role: 'TENANT', status: 'ACTIVE' };
  const propertyDevice = { homeId: 'home-a', managementClass: 'PROPERTY_DEVICE', ownerMembershipId: null, currentAreaId: 'room-1', lifecycle: 'INSTALLED' };
  const privateDevice = { homeId: 'home-a', managementClass: 'TENANT_DEVICE', ownerMembershipId: 'tenant-a', currentAreaId: 'room-1', lifecycle: 'INSTALLED' };
  if (!canReadDevice(membership, propertyDevice, new Set(['room-1'])) || !canCommandDevice(membership, propertyDevice, new Set(['room-1']))) throw new Error('tenant cannot use an authorised property device');
  if (!canReadDevice(membership, privateDevice, new Set(['room-1'])) || !canCommandDevice(membership, privateDevice, new Set(['room-1']))) throw new Error('tenant cannot use its private device in a permitted area');
  if (canReadDevice(membership, privateDevice, new Set()) || canCommandDevice(membership, privateDevice, new Set())) throw new Error('tenant-private device remained available after its area grant was removed');
  if (canReadDevice(otherMembership, privateDevice, new Set(['room-1'])) || canCommandDevice(otherMembership, privateDevice, new Set(['room-1']))) throw new Error('tenant-private device leaked to another tenant');
  if (canReadDevice({ id: 'owner', homeId: 'home-a', role: 'OWNER', status: 'ACTIVE' }, privateDevice, new Set())) throw new Error('tenant-private device leaked to owner');
  if (canCommandDevice({ id: 'owner', homeId: 'home-a', role: 'OWNER', status: 'ACTIVE' }, propertyDevice, new Set(['room-1']))) throw new Error('owner received command scope');
  if (canSelfRemoveMembership({ id: 'manager', homeId: 'home-a', role: 'PROPERTY_MANAGER', status: 'ACTIVE' }, 'manager')) throw new Error('property manager can remove itself');
  if (canSelfRemoveMembership({ id: 'owner', homeId: 'home-a', role: 'OWNER', status: 'ACTIVE' }, 'owner')) throw new Error('owner can remove itself');
  if (!canSelfRemoveMembership({ id: 'tenant', homeId: 'home-a', role: 'TENANT', status: 'ACTIVE' }, 'tenant')) throw new Error('tenant cannot remove its own membership');
  if (!isAssignedWorkAuthorized({ assignedEmployeeId: 'employee', homeId: 'home-a', hubInstallationId: 'hub-a', state: 'ASSIGNED' }, 'employee', 'home-a', 'hub-a')) throw new Error('assigned work should authorize the matching employee');
  if (isAssignedWorkAuthorized({ assignedEmployeeId: 'employee', homeId: 'home-a', hubInstallationId: 'hub-a', state: 'COMPLETED' }, 'employee', 'home-a', 'hub-a')) throw new Error('completed work remained mutable');
  console.log('[test:foundation:invariants] privacy, command scope, equal-name separation and assigned-work authority passed');

  console.log('[test:foundation:invariants] all transactional foundation invariants passed');
} finally {
  await prisma.$disconnect();
}
