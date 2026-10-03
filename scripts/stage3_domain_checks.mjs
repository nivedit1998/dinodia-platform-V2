import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directUrl = process.env.DIRECT_URL || '';
let directTarget;
try { directTarget = new URL(directUrl); } catch { throw new Error('Stage 3 domain checks require an explicit disposable loopback DIRECT_URL'); }
const allowedDatabases = new Set(['dinodia_v2_foundation', 'dinodia_v2_foundation_independent', 'dinodia_v2_foundation_upgrade']);
if (!['127.0.0.1', 'localhost', '::1'].includes(directTarget.hostname) || !allowedDatabases.has(decodeURIComponent(directTarget.pathname.slice(1)))) {
  throw new Error('Stage 3 domain checks refuse non-loopback or non-disposable database targets');
}
const temporary = fs.mkdtempSync(path.join(root, 'node_modules', '.cache', 'dinodia-stage3-service-test-'));
const client = new PrismaClient({ datasourceUrl: directUrl });
const result = spawnSync('npx', ['tsc', '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck', '--strict', '--outDir', temporary,
  'src/lib/nativeHomeContext.ts', 'src/lib/nativeInventory.ts', 'src/lib/nativeDisplayNames.ts', 'src/lib/nativeAreaAccess.ts', 'src/lib/nativeSchemaValidation.ts', 'src/lib/nativeSourceAliases.ts', 'src/lib/nativeSupportTickets.ts', 'src/lib/nativePreferences.ts', 'src/lib/nativeHomeDocuments.ts', 'src/lib/hubReplacementReconciliation.ts'], { cwd: root, encoding: 'utf8' });
if (result.status !== 0) throw new Error(`Stage 3 service compilation failed: ${(result.stdout + result.stderr).slice(-3000)}`);
const require = createRequire(import.meta.url);
const compiled = (file) => require(path.join(temporary, file));
const { resolveNativeHomeContext } = compiled('nativeHomeContext.js');
const { readNativeInventory } = compiled('nativeInventory.js');
const { setTenantDeviceCustomerLabel } = compiled('nativeDisplayNames.js');
const { setAreaOverrideName, setPropertyDeviceOverrideName } = compiled('nativePresentation.js');
const { replaceTenantAreaGrants } = compiled('nativeAreaAccess.js');
const { createNativeSupportTicket } = compiled('nativeSupportTickets.js');
const { compareAndSetMemberPreference } = compiled('nativePreferences.js');
const { compareAndSetHomeDocument } = compiled('nativeHomeDocuments.js');
const { observeAreaSourceAlias, observeDeviceSourceAlias } = compiled('nativeSourceAliases.js');
const { activateReplacementHub, HubReplacementError } = compiled('hubReplacementReconciliation.js');

class RollbackFixture extends Error {}
function invariant(ok, label) { if (!ok) throw new Error(`Stage 3 domain assertion failed: ${label}`); }

try {
  try {
    await client.$transaction(async (tx) => {
      const now = new Date();
      const account = (email) => {
        const username = `s3-${crypto.randomUUID()}`;
        return tx.customerAccount.create({ data: { email, emailNormalized: email.toLowerCase(), username, usernameNormalized: username, displayName: 'Stage 3 isolated test identity', passwordHash: 'stage3-test-only-not-authenticatable', status: 'ACTIVE' } });
      };
      const [ownerAccount, tenantAccount, otherTenantAccount, managerAccountOne, managerAccountTwo] = await Promise.all([
        account(`stage3-owner-${crypto.randomUUID()}@example.invalid`), account(`stage3-tenant-${crypto.randomUUID()}@example.invalid`),
        account(`stage3-other-${crypto.randomUUID()}@example.invalid`), account(`stage3-manager-one-${crypto.randomUUID()}@example.invalid`),
        account(`stage3-manager-two-${crypto.randomUUID()}@example.invalid`),
      ]);
      const home = await tx.home.create({ data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE' } });
      const identity = await tx.hubManufacturingIdentity.create({ data: { serialNumber: `stage3-${crypto.randomUUID()}`, signingPublicKey: 'test-public-signing-key', encryptionPublicKey: 'test-public-encryption-key', signingKeyFingerprint: crypto.randomUUID(), encryptionKeyFingerprint: crypto.randomUUID() } });
      const hub = await tx.hubInstallation.create({ data: { homeId: home.id, manufacturingIdentityId: identity.id, serialNumberSnapshot: identity.serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE' } });
      await tx.home.update({ where: { id: home.id }, data: { activeHubInstallationId: hub.id } });
      const [owner, tenant, otherTenant, managerOne, managerTwo] = await Promise.all([
        tx.homeMembership.create({ data: { customerAccountId: ownerAccount.id, homeId: home.id, role: 'OWNER', status: 'ACTIVE' } }),
        tx.homeMembership.create({ data: { customerAccountId: tenantAccount.id, homeId: home.id, role: 'TENANT', status: 'ACTIVE' } }),
        tx.homeMembership.create({ data: { customerAccountId: otherTenantAccount.id, homeId: home.id, role: 'TENANT', status: 'ACTIVE' } }),
        tx.homeMembership.create({ data: { customerAccountId: managerAccountOne.id, homeId: home.id, role: 'PROPERTY_MANAGER', status: 'ACTIVE' } }),
        tx.homeMembership.create({ data: { customerAccountId: managerAccountTwo.id, homeId: home.id, role: 'PROPERTY_MANAGER', status: 'ACTIVE' } }),
      ]);
      const secondHome = await tx.home.create({ data: { lifecycle: 'INSTALLING', installationStatus: 'DRAFT' } });
      const ownerManagerMembership = await tx.homeMembership.create({ data: { customerAccountId: ownerAccount.id, homeId: secondHome.id, role: 'PROPERTY_MANAGER', status: 'ACTIVE' } });
      const area = await tx.area.create({ data: { homeId: home.id, osAreaId: `os-${crypto.randomUUID()}`, originalName: 'Test area' } });
      const additionalAreas = await Promise.all(Array.from({ length: 12 }, (_, index) => tx.area.create({ data: { homeId: home.id, osAreaId: `os-${crypto.randomUUID()}`, originalName: `Room ${index + 2}` } })));
      const secondTenantArea = additionalAreas[0];
      await tx.tenantAreaGrant.create({ data: { membershipId: tenant.id, areaId: area.id, homeId: home.id, policyRevision: 1 } });
      await tx.tenantAreaGrant.create({ data: { membershipId: tenant.id, areaId: secondTenantArea.id, homeId: home.id, policyRevision: 1 } });
      await tx.tenantAreaGrant.create({ data: { membershipId: otherTenant.id, areaId: area.id, homeId: home.id, policyRevision: 1 } });
      const propertyDevice = await tx.nativeDevice.create({ data: { homeId: home.id, hubInstallationId: hub.id, osDeviceId: `property-${crypto.randomUUID()}`, originalName: 'Property light', technicalLabel: 'lighting', managementClass: 'PROPERTY_DEVICE', deviceType: 'light' } });
      const tenantDevice = await tx.nativeDevice.create({ data: { homeId: home.id, hubInstallationId: hub.id, osDeviceId: `tenant-${crypto.randomUUID()}`, originalName: 'Private light', technicalLabel: 'tenant_device', managementClass: 'TENANT_DEVICE', ownerMembershipId: tenant.id, deviceType: 'light' } });
      const otherPrivate = await tx.nativeDevice.create({ data: { homeId: home.id, hubInstallationId: hub.id, osDeviceId: `other-${crypto.randomUUID()}`, originalName: 'Other private light', technicalLabel: 'tenant_device', managementClass: 'TENANT_DEVICE', ownerMembershipId: otherTenant.id, deviceType: 'light' } });
      for (const device of [propertyDevice, tenantDevice, otherPrivate]) await tx.deviceAreaAssignment.create({ data: { homeId: home.id, deviceId: device.id, areaId: area.id, source: 'STAGE3_TEST' } });
      const rawAreaSourceId = `protocol-area:${crypto.randomUUID()}`;
      const areaAlias = await observeAreaSourceAlias(tx, { homeId: home.id, areaId: area.id, hubInstallationId: hub.id, protocol: 'test-protocol', sourceAreaId: rawAreaSourceId, now });
      const rawDeviceSourceId = `protocol-device:${crypto.randomUUID()}`;
      const deviceAlias = await observeDeviceSourceAlias(tx, { homeId: home.id, deviceId: propertyDevice.id, hubInstallationId: hub.id, protocol: 'test-protocol', sourceDeviceId: rawDeviceSourceId, now });
      const storedAreaAlias = await tx.areaSourceAlias.findUniqueOrThrow({ where: { id: areaAlias.id }, select: { sourceAreaId: true } });
      const storedDeviceAlias = await tx.nativeDeviceSourceAlias.findUniqueOrThrow({ where: { id: deviceAlias.id }, select: { sourceDeviceId: true } });
      invariant(storedAreaAlias.sourceAreaId !== rawAreaSourceId && /^[0-9a-f]{64}$/.test(storedAreaAlias.sourceAreaId), 'area alias stores only a stable SHA-256 digest of its replaceable source identifier');
      invariant(storedDeviceAlias.sourceDeviceId !== rawDeviceSourceId && /^[0-9a-f]{64}$/.test(storedDeviceAlias.sourceDeviceId), 'device alias stores only a stable SHA-256 digest of its replaceable source identifier');

      const context = await resolveNativeHomeContext(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, homeId: home.id });
      const tenantInventory = await readNativeInventory(tx, context);
      invariant(tenantInventory.devices.length === 2, 'tenant sees granted property device and own tenant device');
      invariant(!tenantInventory.devices.some((device) => device.id === otherPrivate.id), 'other tenant device is omitted');
      const ticket = await createNativeSupportTicket(tx, {
        customerAccountId: tenantAccount.id, membershipId: tenant.id, homeId: home.id,
        publicReference: `DNO-S3-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        category: 'DEVICE_PROBLEM', description: 'Private tenant support narrative should not enter timeline metadata', now,
      });
      const timeline = await tx.nativeSupportTicketTimeline.findFirst({ where: { ticketId: ticket.id } });
      invariant(ticket.nativeCategory === 'DEVICE_PROBLEM' && timeline?.customerVisible && timeline.safeSummary === 'Support request created', 'support taxonomy is typed and timeline summary does not copy private narrative');
      const ownerContext = await resolveNativeHomeContext(tx, { customerAccountId: ownerAccount.id, membershipId: owner.id, homeId: home.id });
      const ownerInventory = await readNativeInventory(tx, ownerContext);
      invariant(ownerInventory.devices.length === 1 && ownerInventory.devices[0].id === propertyDevice.id, 'owner sees only permanent property device');
      const managerContext = await resolveNativeHomeContext(tx, { customerAccountId: managerAccountOne.id, membershipId: managerOne.id, homeId: home.id });
      const managerInventory = await readNativeInventory(tx, managerContext);
      invariant(managerInventory.devices.length === 1 && managerInventory.devices[0].id === propertyDevice.id, 'property manager shares property inventory but not tenant-owned devices');
      const secondManagerContext = await resolveNativeHomeContext(tx, { customerAccountId: managerAccountTwo.id, membershipId: managerTwo.id, homeId: home.id });
      invariant((await readNativeInventory(tx, secondManagerContext)).devices.length === 1, 'multiple managers independently share only permanent property inventory');
      let crossHomeDenied = false;
      try { await resolveNativeHomeContext(tx, { customerAccountId: ownerAccount.id, membershipId: ownerManagerMembership.id, homeId: home.id }); } catch { crossHomeDenied = true; }
      invariant(crossHomeDenied, 'same global account cannot use a different home membership at the selected home');

      const layout = await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'DASHBOARD_LAYOUT', expectedRevision: 0, document: { version: 1, tiles: [{ deviceId: tenantDevice.id, size: 'STANDARD' }] } });
      invariant(layout.revision === 1, 'member preference creates at revision one for the selected membership');
      let preferenceRevisionDenied = false;
      try { await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'DASHBOARD_LAYOUT', expectedRevision: 0, document: { version: 1, tiles: [{ deviceId: tenantDevice.id, size: 'LARGE' }] } }); } catch { preferenceRevisionDenied = true; }
      invariant(preferenceRevisionDenied, 'stale member preference revisions cannot overwrite the current document');
      const filters = await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'FILTER_STATE', expectedRevision: 0, document: { version: 1, areaIds: [area.id], deviceIds: [tenantDevice.id] } });
      invariant(filters.revision === 1, 'tenant filter state accepts only currently granted canonical area and owned device IDs');
      const quietHours = await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'QUIET_HOURS', expectedRevision: 0, document: { version: 1, enabled: true, startLocalTime: '22:00', endLocalTime: '07:00', timeZone: 'Europe/London', days: [1, 2, 3, 4, 5, 6, 7] } });
      invariant(quietHours.revision === 1, 'quiet hours persist an IANA zone, local times and unique ISO weekdays');
      let invalidQuietHoursDenied = false;
      try { await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'QUIET_HOURS', expectedRevision: 1, document: { version: 1, enabled: true, startLocalTime: '25:00', endLocalTime: '07:00', timeZone: 'Not/AZone', days: [1] } }); } catch { invalidQuietHoursDenied = true; }
      invariant(invalidQuietHoursDenied, 'invalid local time and time-zone preference is rejected');
      let unknownPreferenceVersionDenied = false;
      try { await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'DASHBOARD_LAYOUT', expectedRevision: 1, document: { version: 2, tiles: [{ deviceId: tenantDevice.id, size: 'STANDARD' }] } }); } catch { unknownPreferenceVersionDenied = true; }
      invariant(unknownPreferenceVersionDenied, 'unknown preference document versions fail explicitly');
      let privateDeviceReferenceDenied = false;
      try { await compareAndSetMemberPreference(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, kind: 'DASHBOARD_LAYOUT', expectedRevision: 1, document: { version: 1, tiles: [{ deviceId: otherPrivate.id, size: 'STANDARD' }] } }); } catch { privateDeviceReferenceDenied = true; }
      invariant(privateDeviceReferenceDenied, 'preference cannot reference another tenant private device');
      const floorplan = await compareAndSetHomeDocument(tx, { customerAccountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, kind: 'FLOORPLAN', expectedRevision: 0, document: { version: 1, areas: [area, ...additionalAreas].map((item, index) => ({ areaId: item.id, x: (index % 4) * 20, y: Math.floor(index / 4) * 20, width: 18, height: 18 })) } });
      invariant(floorplan.revision === 1 && floorplan.document.areas.length === 13, 'shared floorplan accepts more than twelve canonical area IDs without granting access');
      let foreignFloorplanAreaDenied = false;
      try { await compareAndSetHomeDocument(tx, { customerAccountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, kind: 'FLOORPLAN', expectedRevision: 1, document: { version: 1, areas: [{ areaId: ownerManagerMembership.id, x: 0, y: 0, width: 10, height: 10 }] } }); } catch { foreignFloorplanAreaDenied = true; }
      invariant(foreignFloorplanAreaDenied, 'floorplan rejects non-area identifiers and foreign/noncanonical references');
      let overflowFloorplanDenied = false;
      try { await compareAndSetHomeDocument(tx, { customerAccountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, kind: 'FLOORPLAN', expectedRevision: 1, document: { version: 1, areas: [{ areaId: area.id, x: 9999, y: 0, width: 2, height: 10 }] } }); } catch { overflowFloorplanDenied = true; }
      invariant(overflowFloorplanDenied, 'floorplan geometry cannot extend beyond the bounded canvas');

      const preInstallAccount = await account(`stage3-preinstall-${crypto.randomUUID()}@example.invalid`);
      const preInstallHome = await tx.home.create({ data: { lifecycle: 'ACTIVE', installationStatus: 'DRAFT' } });
      const preInstallOwner = await tx.homeMembership.create({ data: { customerAccountId: preInstallAccount.id, homeId: preInstallHome.id, role: 'OWNER', status: 'ACTIVE' } });
      let preInstallDenied = false;
      try { await resolveNativeHomeContext(tx, { customerAccountId: preInstallAccount.id, membershipId: preInstallOwner.id, homeId: preInstallHome.id }); } catch { preInstallDenied = true; }
      invariant(preInstallDenied, 'pre-completion home cannot return a customer projection');
      let suspendedAccountDenied = false;
      const suspendedEmail = `stage3-suspended-${crypto.randomUUID()}@example.invalid`;
      const suspendedUsername = `s3-${crypto.randomUUID()}`;
      const suspendedAccount = await tx.customerAccount.create({ data: { email: suspendedEmail, emailNormalized: suspendedEmail.toLowerCase(), username: suspendedUsername, usernameNormalized: suspendedUsername, displayName: 'Suspended isolated test identity', passwordHash: 'stage3-test-only-not-authenticatable', status: 'SUSPENDED' } });
      try { await resolveNativeHomeContext(tx, { customerAccountId: suspendedAccount.id, membershipId: tenant.id, homeId: home.id }); } catch { suspendedAccountDenied = true; }
      invariant(suspendedAccountDenied, 'suspended global identity cannot use an otherwise active membership');

      await setTenantDeviceCustomerLabel(tx, { accountId: tenantAccount.id, membershipId: tenant.id, homeId: home.id, deviceId: tenantDevice.id, expectedInventoryRevision: 1, label: 'My lights' });
      let wrongOwnerDenied = false;
      try { await setTenantDeviceCustomerLabel(tx, { accountId: otherTenantAccount.id, membershipId: otherTenant.id, homeId: home.id, deviceId: tenantDevice.id, expectedInventoryRevision: 2, label: 'Not mine' }); } catch { wrongOwnerDenied = true; }
      invariant(wrongOwnerDenied, 'another tenant cannot rename the private device');

      const changed = await replaceTenantAreaGrants(tx, { actorAccountId: ownerAccount.id, actorMembershipId: owner.id, tenantMembershipId: tenant.id, homeId: home.id, areaIds: [secondTenantArea.id], expectedManagementRevision: home.managementRevision, now });
      invariant(changed.changed && changed.managementRevision === home.managementRevision + 1, 'owner grant replacement increments the authoritative revision');
      invariant(changed.decommissionTombstoneCount === 1, 'revoking the device assigned area queues its decommission even when an unrelated area grant remains');
      invariant(!(await tx.nativeDevice.findUnique({ where: { id: tenantDevice.id } })), 'grant removal erases the tenant device cloud projection in the same transaction');
      invariant(Boolean(await tx.nativeDevice.findUnique({ where: { id: otherPrivate.id } })), 'grant removal leaves another tenant private device untouched');
      invariant((await tx.hubInstallation.findUniqueOrThrow({ where: { id: hub.id }, select: { cleanupState: true, cleanupGeneration: true } })).cleanupState === 'WAITING_FOR_TENANT_DEVICE_CLEANUP', 'hub is explicitly not clean/healthy before pending tenant-device removal is acknowledged');
      invariant(await tx.nativeDomainOutbox.count({ where: { homeId: home.id, eventType: 'TENANT_DEVICE_DECOMMISSION', aggregateId: tenantDevice.id, expiresAt: { gt: now } } }) === 1, 'device tombstone is durable, exact-targeted, and bounded');
      const afterRevokeContext = await resolveNativeHomeContext(tx, { customerAccountId: tenantAccount.id, membershipId: tenant.id, homeId: home.id });
      invariant((await readNativeInventory(tx, afterRevokeContext)).devices.length === 0, 'revoked grant immediately removes inventory');
      let staleConflict = false;
      try { await replaceTenantAreaGrants(tx, { actorAccountId: ownerAccount.id, actorMembershipId: owner.id, tenantMembershipId: tenant.id, homeId: home.id, areaIds: [area.id], expectedManagementRevision: home.managementRevision, now }); } catch { staleConflict = true; }
      invariant(staleConflict, 'stale home-management revision is rejected');
      const areaPresentation = await setAreaOverrideName(tx, { accountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, areaId: area.id, expectedAreaRevision: area.revision, expectedManagementRevision: changed.managementRevision, overrideName: 'Bedroom', now });
      invariant(areaPresentation.overrideName === 'Bedroom' && areaPresentation.originalName === 'Test area', 'area override preserves the OS source name');
      const restoredPresentation = await setAreaOverrideName(tx, { accountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, areaId: area.id, expectedAreaRevision: areaPresentation.revision, expectedManagementRevision: areaPresentation.managementRevision, overrideName: null, now });
      invariant(restoredPresentation.overrideName === null && restoredPresentation.originalName === 'Test area', 'restoring an area name clears only the override');
      const propertyName = await setPropertyDeviceOverrideName(tx, { accountId: ownerAccount.id, membershipId: owner.id, homeId: home.id, deviceId: propertyDevice.id, expectedInventoryRevision: propertyDevice.inventoryRevision, overrideName: 'Hall light', now });
      invariant(propertyName.overrideName === 'Hall light' && propertyName.originalName === 'Property light', 'property device override retains source name');

      const employeeEmail = `stage3-installer-${crypto.randomUUID()}@example.invalid`;
      const employee = await tx.companyEmployeeAccount.create({ data: { displayName: 'Stage 3 installer fixture', email: employeeEmail, emailNormalized: employeeEmail.toLowerCase(), role: 'INSTALLER', status: 'ACTIVE' } });
      const replacementHome = await tx.home.create({ data: { lifecycle: 'MAINTENANCE', installationStatus: 'COMPLETE' } });
      const replacementIdentities = await Promise.all([0, 1].map((n) => tx.hubManufacturingIdentity.create({ data: {
        serialNumber: `stage3-replacement-${n}-${crypto.randomUUID()}`, signingPublicKey: 'test-signing-key', encryptionPublicKey: 'test-encryption-key',
        signingKeyFingerprint: crypto.randomUUID(), encryptionKeyFingerprint: crypto.randomUUID(),
      } })));
      const oldHub = await tx.hubInstallation.create({ data: { homeId: replacementHome.id, manufacturingIdentityId: replacementIdentities[0].id, serialNumberSnapshot: replacementIdentities[0].serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE' } });
      const replacementHost = `stage3-replacement-${crypto.randomUUID()}.dinodiasmartliving.com`;
      const nextHub = await tx.hubInstallation.create({ data: { homeId: replacementHome.id, manufacturingIdentityId: replacementIdentities[1].id, serialNumberSnapshot: replacementIdentities[1].serialNumber, state: 'PROVISIONED', lifecycleStatus: 'PENDING', cloudUrl: `https://${replacementHost}`, reservedHostname: replacementHost, cloudUrlVerifiedAt: now, remoteVerificationAt: now } });
      await tx.home.update({ where: { id: replacementHome.id }, data: { activeHubInstallationId: oldHub.id } });
      const replacementResult = await activateReplacementHub(tx, { homeId: replacementHome.id, actorEmployeeId: employee.id, expectedCurrentHubId: oldHub.id, replacementHubId: nextHub.id, expectedManagementRevision: replacementHome.managementRevision, now });
      invariant(replacementResult.activeHubId === nextHub.id && (await tx.home.findUniqueOrThrow({ where: { id: replacementHome.id }, select: { activeHubInstallationId: true } })).activeHubInstallationId === nextHub.id, 'authorised empty-inventory hub replacement switches one explicit active pointer');

      const occupiedHome = await tx.home.create({ data: { lifecycle: 'MAINTENANCE', installationStatus: 'COMPLETE' } });
      const occupiedIdentities = await Promise.all([0, 1].map((n) => tx.hubManufacturingIdentity.create({ data: {
        serialNumber: `stage3-occupied-replacement-${n}-${crypto.randomUUID()}`, signingPublicKey: 'test-signing-key', encryptionPublicKey: 'test-encryption-key',
        signingKeyFingerprint: crypto.randomUUID(), encryptionKeyFingerprint: crypto.randomUUID(),
      } })));
      const occupiedOld = await tx.hubInstallation.create({ data: { homeId: occupiedHome.id, manufacturingIdentityId: occupiedIdentities[0].id, serialNumberSnapshot: occupiedIdentities[0].serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE' } });
      const occupiedHost = `stage3-occupied-${crypto.randomUUID()}.dinodiasmartliving.com`;
      const occupiedNext = await tx.hubInstallation.create({ data: { homeId: occupiedHome.id, manufacturingIdentityId: occupiedIdentities[1].id, serialNumberSnapshot: occupiedIdentities[1].serialNumber, state: 'PROVISIONED', lifecycleStatus: 'PENDING', cloudUrl: `https://${occupiedHost}`, reservedHostname: occupiedHost, cloudUrlVerifiedAt: now, remoteVerificationAt: now } });
      await tx.home.update({ where: { id: occupiedHome.id }, data: { activeHubInstallationId: occupiedOld.id } });
      const occupiedDevice = await tx.nativeDevice.create({ data: { homeId: occupiedHome.id, hubInstallationId: occupiedOld.id, osDeviceId: `occupied-${crypto.randomUUID()}`, originalName: 'Unreconciled device', technicalLabel: 'lighting', managementClass: 'PROPERTY_DEVICE', deviceType: 'light' } });
      let occupiedReplacementDenied = false;
      try { await activateReplacementHub(tx, { homeId: occupiedHome.id, actorEmployeeId: employee.id, expectedCurrentHubId: occupiedOld.id, replacementHubId: occupiedNext.id, expectedManagementRevision: occupiedHome.managementRevision, now }); }
      catch (error) { occupiedReplacementDenied = error instanceof HubReplacementError; }
      invariant(occupiedReplacementDenied && (await tx.home.findUniqueOrThrow({ where: { id: occupiedHome.id }, select: { activeHubInstallationId: true } })).activeHubInstallationId === occupiedOld.id
        && (await tx.nativeDevice.findUniqueOrThrow({ where: { id: occupiedDevice.id }, select: { lifecycle: true, hubInstallationId: true } })).lifecycle === 'DISCOVERED', 'replacement with unreconciled devices is denied before hub, authority or device mutation');
      throw new RollbackFixture('intentional rollback of all Stage 3 test fixtures');
    }, { timeout: 15000 });
  } catch (error) { if (!(error instanceof RollbackFixture)) throw error; }
  let ownerCardinalityDenied = false;
  try {
    await client.$transaction(async (tx) => {
      const verifiedAt = new Date();
      const identity = await tx.hubManufacturingIdentity.create({ data: {
        serialNumber: `stage3-owner-guard-${crypto.randomUUID()}`, signingPublicKey: 'guard-test-signing-key',
        encryptionPublicKey: 'guard-test-encryption-key', signingKeyFingerprint: crypto.randomUUID(), encryptionKeyFingerprint: crypto.randomUUID(),
      } });
      const home = await tx.home.create({ data: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', addressStatus: 'VERIFIED', addressLine1: 'Test', city: 'Test', postcode: 'TST 1AA', country: 'GB', timezone: 'Europe/London' } });
      const cloudHost = `stage3-${crypto.randomUUID()}.dinodiasmartliving.com`;
      const hub = await tx.hubInstallation.create({ data: { homeId: home.id, manufacturingIdentityId: identity.id, serialNumberSnapshot: identity.serialNumber, state: 'ACTIVE', lifecycleStatus: 'ACTIVE', cloudUrl: `https://${cloudHost}`, reservedHostname: cloudHost, cloudUrlVerifiedAt: verifiedAt, remoteChallengeAt: verifiedAt, remoteVerificationAt: verifiedAt } });
      await tx.area.create({ data: { homeId: home.id, osAreaId: `guard-${crypto.randomUUID()}`, originalName: 'Verified area' } });
      await tx.home.update({ where: { id: home.id }, data: { activeHubInstallationId: hub.id } });
    });
  } catch (error) { ownerCardinalityDenied = String(error).includes('active home must have exactly one active owner membership'); }
  invariant(ownerCardinalityDenied, 'database specifically rejects an otherwise-complete active home with zero active owners');
  let crossHomeGrantDenied = false;
  try {
    await client.$transaction(async (tx) => {
      const email = `stage3-cross-home-${crypto.randomUUID()}@example.invalid`;
      const username = `s3-${crypto.randomUUID()}`;
      const account = await tx.customerAccount.create({ data: { email, emailNormalized: email.toLowerCase(), username, usernameNormalized: username, displayName: 'Stage 3 isolated cross-home identity', passwordHash: 'stage3-test-only-not-authenticatable' } });
      const [grantHome, foreignHome] = await Promise.all([tx.home.create({ data: {} }), tx.home.create({ data: {} })]);
      const membership = await tx.homeMembership.create({ data: { customerAccountId: account.id, homeId: grantHome.id, role: 'TENANT', status: 'ACTIVE' } });
      const foreignArea = await tx.area.create({ data: { homeId: foreignHome.id, osAreaId: `foreign-${crypto.randomUUID()}`, originalName: 'Foreign area' } });
      await tx.tenantAreaGrant.create({ data: { membershipId: membership.id, areaId: foreignArea.id, homeId: grantHome.id, policyRevision: 1 } });
    });
  } catch (error) { crossHomeGrantDenied = error?.code === 'P2003'; }
  invariant(crossHomeGrantDenied, 'PostgreSQL rejects a tenant grant combining a home membership with another home area (Prisma reports a foreign-key violation)');
  console.log('[test:stage3-domain] PASS: account-global multi-home roles, one owner/multiple managers, selected-home binding, pre-completion fail-closed, suspended-account denial, property/tenant privacy, tenant-owned label, grant revocation/outbox cleanup, membership preference schemas/CAS, 13-area canonical floorplan, digested source aliases, stale revision, support privacy timeline, exact owner cardinality and same-home grant FK; fixtures rolled back');
} finally {
  await client.$disconnect();
  fs.rmSync(temporary, { recursive: true, force: true });
}
