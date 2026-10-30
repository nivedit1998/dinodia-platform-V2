import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { decryptPlatformEnvelope, encryptPlatformEnvelope } from '@/lib/hubOperatorCredentials';
import { PlatformDataEncryptionKeyError } from '@/lib/platformDataEncryptionKey';
import { serializableTransaction } from '@/lib/serializableTransaction';
import { refreshNativeAlexaEventToken } from '@/lib/nativeAlexaGrant';
import { alexaPropertiesFromStates, type AuthorizedEndpoint } from '@/lib/nativeAlexaExecution';
import { ensureAutoScopes } from '@/lib/alexa/syncAlexa';
import { projectAlexaLinkEndpoints } from '@/lib/alexa/projection';

const MAX_CHANGE_REPORTS_PER_TICK = 4;
const GATEWAY_TIMEOUT_MS = 4000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_OUTBOX_ATTEMPTS = 8;
const CHANGE_REPORT_CAUSES = new Set(['APP_INTERACTION', 'PERIODIC_POLL', 'PHYSICAL_INTERACTION', 'VOICE_INTERACTION']);

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function eventGatewayEndpoint(): string {
  const configuredTestEndpoint = String(process.env.DINODIA_ALEXA_EVENTS_LOOPBACK_TEST_ENDPOINT ?? '');
  if (process.env.V2_ENVIRONMENT === 'test' && configuredTestEndpoint) {
    try {
      const url = new URL(configuredTestEndpoint);
      if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
        && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash
        && url.pathname === '/v3/events') return url.toString();
    } catch { /* fail closed below */ }
    throw new Error('Alexa test event-gateway endpoint is invalid');
  }
  return 'https://api.eu.amazonalexa.com/v3/events';
}

async function refreshLinkToken(linkId: string, force = false): Promise<boolean> {
  const hint = await prisma.alexaNativeLink.findUnique({ where: { id: linkId }, select: {
    id: true, customerAccountId: true, status: true, revokedAt: true, revision: true,
    accessTokenCiphertext: true, refreshTokenCiphertext: true, accessTokenExpiresAt: true,
  } });
  const now = new Date();
  if (!hint || hint.status !== 'ACTIVE' || hint.revokedAt || !hint.accessTokenCiphertext || !hint.refreshTokenCiphertext) return false;
  if (!force && hint.accessTokenExpiresAt && hint.accessTokenExpiresAt.getTime() > now.getTime() + TOKEN_REFRESH_SKEW_MS) return true;
  let oldRefreshToken: string;
  try { oldRefreshToken = decryptPlatformEnvelope(hint.refreshTokenCiphertext); }
  catch (error) {
    if (error instanceof PlatformDataEncryptionKeyError) throw error;
    return false;
  }
  let refreshed: Awaited<ReturnType<typeof refreshNativeAlexaEventToken>>;
  try { refreshed = await refreshNativeAlexaEventToken(oldRefreshToken); }
  catch { return false; }
  return serializableTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.customerAccountId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${hint.id}::uuid FOR UPDATE`;
    const link = await tx.alexaNativeLink.findUnique({ where: { id: hint.id }, select: {
      id: true, customerAccountId: true, status: true, revokedAt: true, refreshTokenCiphertext: true,
      customerAccount: { select: { status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true,
        policyAcceptances: { where: { policyKind: 'DINODIA_NATIVE', policyVersion: currentCustomerPolicy()?.version ?? '__unavailable__' }, select: { id: true } } } },
    } });
    const policy = currentCustomerPolicy();
    const currentNow = new Date();
    if (!link || link.customerAccountId !== hint.customerAccountId || link.status !== 'ACTIVE' || link.revokedAt
      || link.refreshTokenCiphertext !== hint.refreshTokenCiphertext
      || link.customerAccount.status !== 'ACTIVE' || !link.customerAccount.emailVerifiedAt
      || link.customerAccount.mustChangePassword || link.customerAccount.usernameSelectionRequired
      || !policy || link.customerAccount.policyAcceptances.length === 0) return false;
    await tx.alexaNativeLink.update({ where: { id: link.id }, data: {
      accessTokenCiphertext: JSON.stringify(encryptPlatformEnvelope(refreshed.accessToken)),
      refreshTokenCiphertext: JSON.stringify(encryptPlatformEnvelope(refreshed.refreshToken)),
      encryptionKeyVersion: 1,
      accessTokenExpiresAt: new Date(currentNow.getTime() + refreshed.expiresIn * 1000),
      revision: { increment: 1 }, updatedAt: currentNow,
    } });
    return true;
  }, 2, { timeoutMs: 5000 });
}

function delayForAttempt(attempt: number): number {
  return Math.min(15 * 60_000, 10_000 * (2 ** Math.max(0, attempt - 1)));
}

async function deliverOne(id: string, nowHint: Date): Promise<'DELIVERED' | 'CANCELLED' | 'EXPIRED' | 'RETRY' | 'FAILED' | 'SKIPPED' | 'REFRESH'> {
  const rowHint = await prisma.nativeDomainOutbox.findUnique({ where: { id }, select: { id: true, payload: true, state: true } });
  if (!rowHint || rowHint.state !== 'PENDING') return 'SKIPPED';
  const hintPayload = object(rowHint.payload);
  const linkId = typeof hintPayload?.linkId === 'string' ? hintPayload.linkId : '';
  if (!linkId) {
    await prisma.nativeDomainOutbox.updateMany({ where: { id, state: 'PENDING' }, data: { state: 'CANCELLED', updatedAt: new Date() } });
    return 'CANCELLED';
  }
  if (!(await refreshLinkToken(linkId))) {
    const attempts = (await prisma.nativeDomainOutbox.findUnique({ where: { id }, select: { attempts: true } }))?.attempts ?? 0;
    await prisma.nativeDomainOutbox.updateMany({ where: { id, state: 'PENDING' }, data: {
      attempts: attempts + 1, nextAttemptAt: new Date(nowHint.getTime() + 120_000),
      state: attempts + 1 >= MAX_OUTBOX_ATTEMPTS ? 'FAILED' : 'PENDING', updatedAt: new Date(),
    } });
    return 'RETRY';
  }

  let refreshAfter = false;
  try {
    const outcome = await serializableTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "NativeDomainOutbox" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const row = await tx.nativeDomainOutbox.findUnique({ where: { id }, select: {
        id: true, homeId: true, hubInstallationId: true, aggregateId: true, idempotencyKey: true,
        payload: true, state: true, attempts: true, expiresAt: true,
      } });
      if (!row || row.state !== 'PENDING') return 'SKIPPED' as const;
      const now = new Date(); // evaluate after the outbox lock
      if (row.expiresAt <= now) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'EXPIRED', updatedAt: now } });
        return 'EXPIRED' as const;
      }
      if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return 'SKIPPED' as const;
      const payload = object(row.payload);
      if (!payload || typeof payload.linkId !== 'string' || typeof payload.endpointProjectionId !== 'string'
        || typeof payload.homeId !== 'string' || typeof payload.membershipId !== 'string' || typeof payload.areaId !== 'string'
        || typeof payload.deviceId !== 'string' || typeof payload.controlId !== 'string' || !Number.isSafeInteger(payload.descriptorRevision)
        || !Number.isSafeInteger(payload.stateRevision) || typeof payload.observedAt !== 'string'
        || !CHANGE_REPORT_CAUSES.has(String(payload.causeType))
        || row.homeId !== payload.homeId || !row.hubInstallationId) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const tenantOwnedEvent = payload.tenantOwned === true;
      if (tenantOwnedEvent && (typeof payload.ownerMembershipId !== 'string' || payload.ownerMembershipId !== payload.membershipId
        || !object(payload.tenantOwnedState))) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const linkHint = await tx.alexaNativeLink.findUnique({ where: { id: payload.linkId }, select: { customerAccountId: true } });
      if (!linkHint) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      // Match selected-home authority mutation order; the locks remain held
      // through the bounded gateway call so a concurrent unlink/revocation
      // cannot slip between authorization and delivery.
      await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${payload.homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${linkHint.customerAccountId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${payload.linkId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${payload.membershipId}::uuid AND "homeId" = ${payload.homeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${payload.membershipId}::uuid AND "homeId" = ${payload.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeHomeScope" WHERE "linkId" = ${payload.linkId}::uuid AND "membershipId" = ${payload.membershipId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "AlexaNativeEndpointProjection" WHERE "id" = ${payload.endpointProjectionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "NativeDevice" WHERE "id" = ${payload.deviceId}::uuid FOR UPDATE`;
      const policy = currentCustomerPolicy();
      const currentDeviceWhere: Prisma.NativeDeviceWhereInput = {
        homeId: payload.homeId, hubInstallationId: row.hubInstallationId,
        managementClass: tenantOwnedEvent ? 'TENANT_DEVICE' : 'PROPERTY_DEVICE',
        ownerMembershipId: tenantOwnedEvent ? String(payload.ownerMembershipId) : null,
        lifecycle: 'INSTALLED', descriptorRevision: Number(payload.descriptorRevision),
        assignments: { some: { homeId: payload.homeId, areaId: payload.areaId, validFrom: { lte: now }, validUntil: null } },
      };
      const currentEndpointWhere: Prisma.AlexaNativeEndpointProjectionWhereInput = {
        id: payload.endpointProjectionId, linkId: payload.linkId, homeId: payload.homeId,
        membershipId: payload.membershipId, deviceId: payload.deviceId, areaId: payload.areaId,
        endpointId: row.aggregateId, status: 'ACTIVE', descriptorRevision: Number(payload.descriptorRevision),
        link: {
          status: 'ACTIVE', revokedAt: null, accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null },
          oauthFamilies: { some: { revokedAt: null, absoluteExpiresAt: { gt: now }, inactivityExpiresAt: { gt: now } } },
          customerAccount: {
            id: linkHint.customerAccountId, status: 'ACTIVE', emailVerifiedAt: { not: null },
            mustChangePassword: false, usernameSelectionRequired: false,
            policyAcceptances: { some: { policyKind: 'DINODIA_NATIVE', policyVersion: policy?.version ?? '__unavailable__' } },
          },
        },
        home: { lifecycle: 'ACTIVE', installationStatus: 'COMPLETE', activeHubInstallationId: row.hubInstallationId },
        membership: { role: 'TENANT', status: 'ACTIVE', customerAccountId: linkHint.customerAccountId,
          tenantAreaGrants: { some: { areaId: payload.areaId, revokedAt: null, area: { status: 'ACTIVE' } } } },
        area: { homeId: payload.homeId, status: 'ACTIVE' },
        device: currentDeviceWhere,
      };
      const current = await tx.alexaNativeEndpointProjection.findFirst({ where: currentEndpointWhere, select: {
        id: true, endpointId: true, linkId: true, homeId: true, membershipId: true, areaId: true,
        descriptorRevision: true, capabilities: true,
        link: { select: { revision: true, accessTokenCiphertext: true, refreshTokenCiphertext: true, accessTokenExpiresAt: true } },
        device: { select: { osDeviceId: true, descriptorDigest: true, capabilitySummary: true, managementClass: true, ownerMembershipId: true } },
        area: { select: { id: true } },
        home: { select: { activeHubInstallation: { select: { accessPolicyRevision: true } } } },
        membership: { select: { accessRevision: true } },
      } });
      if (!policy || !current) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const scope = await tx.alexaNativeHomeScope.findFirst({ where: {
        linkId: current.linkId, homeId: current.homeId, membershipId: current.membershipId, revokedAt: null,
        areaSelections: { some: { areaId: current.areaId, revokedAt: null } },
      }, select: { id: true } });
      if (!scope || !current.home.activeHubInstallation) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const tenantOwned = current.device.managementClass === 'TENANT_DEVICE';
      if (tenantOwned !== tenantOwnedEvent || tenantOwned && (current.device.ownerMembershipId !== current.membershipId || current.membershipId !== payload.membershipId)) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const summary = object(current.device.capabilitySummary);
      const catalog = object(summary?.controlCatalog);
      const catalogControls = Array.isArray(catalog?.controls) ? catalog.controls.map(object).filter((item): item is JsonObject => item !== null) : [];
      const stateMap = object(summary?.alexaStateByControl);
      const privateState = tenantOwned ? object(payload.tenantOwnedState) : null;
      const currentState = tenantOwned ? privateState : object(stateMap?.[String(payload.controlId)]);
      const endpointCapabilities = object(current.capabilities);
      const controls = Array.isArray(endpointCapabilities?.controls) ? endpointCapabilities.controls.map(object).filter((item): item is JsonObject => item !== null) : [];
      const control = controls.find((item) => item.controlId === payload.controlId);
      const currentCatalogControl = catalogControls.find((item) => item.controlId === payload.controlId);
      if (!currentState || !control || !currentCatalogControl
        || currentState.deviceId !== current.device.osDeviceId || currentState.homeId !== current.homeId
        || currentState.descriptorRevision !== current.descriptorRevision || currentState.revision !== payload.stateRevision
        || currentState.observedAt !== payload.observedAt || currentState.causeType !== payload.causeType
        || currentState.sourceGeneration !== Number(payload.sourceGeneration ?? currentState.sourceGeneration)
        || currentState.controlId !== payload.controlId || currentState.revision !== payload.stateRevision
        || Date.parse(String(currentState.validUntil)) <= now.getTime()
        || currentCatalogControl.controlId !== control.controlId || currentCatalogControl.readable !== true || currentCatalogControl.observable !== true
        || currentCatalogControl.stepUpPolicy === 'required' || ['sensitive', 'critical'].includes(String(currentCatalogControl.riskLevel))) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      if (!current.link.accessTokenCiphertext || !current.link.refreshTokenCiphertext || !current.link.accessTokenExpiresAt
        || current.link.accessTokenExpiresAt <= now) return 'REFRESH' as const;
      let accessToken = '';
      try { accessToken = decryptPlatformEnvelope(current.link.accessTokenCiphertext); }
      catch (error) {
        if (error instanceof PlatformDataEncryptionKeyError) throw error;
        /* A malformed stored envelope is handled fail-closed below. */
      }
      if (!accessToken || accessToken.length < 16 || accessToken.length > 8192) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'FAILED', updatedAt: now } });
        return 'FAILED' as const;
      }
      const mappedEndpoint: AuthorizedEndpoint = {
        accountId: linkHint.customerAccountId, linkId: current.linkId, endpointId: current.endpointId,
        homeId: current.homeId, membershipId: current.membershipId, areaId: current.areaId,
        hubId: row.hubInstallationId!, osDeviceId: current.device.osDeviceId,
        descriptorRevision: current.descriptorRevision,
        accessRevision: current.membership.accessRevision,
        hubPolicyRevision: current.home.activeHubInstallation.accessPolicyRevision,
        cloudUrl: '', reservedHostname: '', controls, displayName: 'Dinodia device',
      };
      const properties = alexaPropertiesFromStates(mappedEndpoint, controls, [currentState], now.getTime());
      if (properties.length === 0) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'CANCELLED', updatedAt: now } });
        return 'CANCELLED' as const;
      }
      const messageId = `dinodia-${createHash('sha256').update(row.idempotencyKey, 'utf8').digest('hex')}`;
      const body = {
        event: { header: { namespace: 'Alexa', name: 'ChangeReport', messageId, payloadVersion: '3' },
          endpoint: { scope: { type: 'BearerToken', token: accessToken }, endpointId: current.endpointId },
          payload: { change: { cause: { type: String(payload.causeType) }, properties } } },
      };
      const response = await fetch(eventGatewayEndpoint(), { method: 'POST', headers: {
        authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json',
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS), redirect: 'manual' });
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'DELIVERED', attempts: { increment: 1 }, updatedAt: now } });
        return 'DELIVERED' as const;
      }
      if (response.status === 401) {
        await tx.nativeDomainOutbox.update({ where: { id }, data: { state: 'PENDING', attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 15_000), updatedAt: now } });
        return 'REFRESH' as const;
      }
      const attempts = row.attempts + 1;
      const retryable = response.status === 429 || response.status >= 500;
      await tx.nativeDomainOutbox.update({ where: { id }, data: {
        state: retryable && attempts < MAX_OUTBOX_ATTEMPTS && row.expiresAt > now ? 'PENDING' : 'FAILED',
        attempts, nextAttemptAt: new Date(now.getTime() + delayForAttempt(attempts)), updatedAt: now,
      } });
      return retryable && attempts < MAX_OUTBOX_ATTEMPTS ? 'RETRY' as const : 'FAILED' as const;
    }, 1, { timeoutMs: GATEWAY_TIMEOUT_MS + 3000, maxWaitMs: 3000 });
    refreshAfter = outcome === 'REFRESH';
    return outcome;
  } catch (error) {
    if (error instanceof PlatformDataEncryptionKeyError) throw error;
    // Never log the event, token, endpoint or exception message. A bounded
    // database code distinguishes a rolled-back delivery from gateway refusal.
    const failureCode = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code) : '';
    if (/^P\d{4}$/.test(failureCode)) console.warn(`[native-alexa-delivery] database code=${failureCode}`);
    const latest = await prisma.nativeDomainOutbox.findUnique({ where: { id }, select: { attempts: true, expiresAt: true } }).catch(() => null);
    const attempts = (latest?.attempts ?? 0) + 1;
    await prisma.nativeDomainOutbox.updateMany({ where: { id, state: 'PENDING' }, data: {
      attempts, state: attempts < MAX_OUTBOX_ATTEMPTS && latest?.expiresAt && latest.expiresAt > new Date() ? 'PENDING' : 'FAILED',
      nextAttemptAt: new Date(Date.now() + delayForAttempt(attempts)), updatedAt: new Date(),
    } }).catch(() => {});
    return 'RETRY';
  } finally {
    if (refreshAfter) await refreshLinkToken(linkId, true).catch((error) => {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      return false;
    });
  }
}

/** Bounded ChangeReport delivery under the existing two-minute Operations lease. */
export async function dispatchNativeAlexaChangeReports(now = new Date()) {
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return { enabled: false, scanned: 0, delivered: 0, cancelled: 0, expired: 0, retried: 0, failed: 0 };
  const candidates = await prisma.nativeDomainOutbox.findMany({ where: {
    aggregateType: 'AlexaChangeReport', eventType: 'ALEXA_CHANGE_REPORT', state: 'PENDING',
    nextAttemptAt: { lte: now }, expiresAt: { gt: now },
  }, orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }], take: MAX_CHANGE_REPORTS_PER_TICK, select: { id: true } });
  const result = { enabled: true, scanned: candidates.length, delivered: 0, cancelled: 0, expired: 0, retried: 0, failed: 0 };
  for (const candidate of candidates) {
    const outcome = await deliverOne(candidate.id, now);
    if (outcome === 'DELIVERED') result.delivered += 1;
    else if (outcome === 'CANCELLED') result.cancelled += 1;
    else if (outcome === 'EXPIRED') result.expired += 1;
    else if (outcome === 'FAILED') result.failed += 1;
    else if (outcome === 'RETRY' || outcome === 'REFRESH') result.retried += 1;
  }
  return result;
}

// ---- Proactive "devices added / changed / removed" reports ------------------------------------------------------

const MAX_LINKS_PER_SWEEP = 3;
const MAX_ENDPOINTS_PER_REPORT = 100;

/**
 * Keeps every auto-scope link in step with the tenant's real access and tells Alexa what changed: AddOrUpdateReport for
 * new, renamed or changed devices and DeleteReport for devices that are gone. The truth is the endpoint projection rows
 * (payloadHash against announcedHash), so a missed run, a failed delivery or a restart simply catches up on the next
 * two-minute tick. Bounded per tick; links rotate by their last sweep time.
 */
export async function dispatchAlexaDiscoveryReports(now = new Date()) {
  const empty = { enabled: false, links: 0, added: 0, removed: 0, failed: 0 };
  if (process.env.DINODIA_NATIVE_ALEXA_ENABLED !== 'true') return empty;
  const links = await prisma.alexaNativeLink.findMany({ where: { status: 'ACTIVE', revokedAt: null, autoScope: true },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: MAX_LINKS_PER_SWEEP, select: { id: true, customerAccountId: true } });
  const result = { enabled: true, links: links.length, added: 0, removed: 0, failed: 0 };
  for (const link of links) {
    try {
      const pending = await serializableTransaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${link.customerAccountId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${link.id}::uuid FOR UPDATE`;
        const current = await tx.alexaNativeLink.findUnique({ where: { id: link.id }, select: {
          id: true, customerAccountId: true, status: true, revokedAt: true, autoScope: true, announcedEndpointIds: true,
          customerAccount: { select: { status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } },
        } });
        const swept = new Date();
        if (!current || current.status !== 'ACTIVE' || current.revokedAt || !current.autoScope) return null;
        const account = current.customerAccount;
        if (account.status !== 'ACTIVE' || !account.emailVerifiedAt || account.mustChangePassword || account.usernameSelectionRequired) {
          await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: link.id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: swept } });
        } else {
          await ensureAutoScopes(tx, current, swept);
          await projectAlexaLinkEndpoints(tx, current, swept);
        }
        await tx.alexaNativeLink.update({ where: { id: link.id }, data: { updatedAt: swept } });
        // Adds: active endpoints whose Alexa-ready form differs from what Alexa was last told.
        // Removes: ids Alexa is known to have that are no longer active, however they stopped being active (revoked,
        // re-created under a new id, or deleted by another Platform path such as area deletion or tenant removal).
        const rows = await tx.alexaNativeEndpointProjection.findMany({ where: { linkId: link.id, status: 'ACTIVE', payloadHash: { not: null } },
          orderBy: { id: 'asc' }, select: { id: true, endpointId: true, payloadHash: true, announcedHash: true, capabilities: true } });
        const adds = rows.filter((row) => row.payloadHash !== row.announcedHash)
          .map((row) => ({ id: row.id, hash: row.payloadHash as string, endpoint: object(object(row.capabilities)?.alexaEndpoint) }))
          .filter((row): row is { id: string; hash: string; endpoint: JsonObject } => row.endpoint !== null);
        const activeIds = new Set(rows.map((row) => row.endpointId));
        const known = Array.isArray(current.announcedEndpointIds)
          ? current.announcedEndpointIds.filter((item): item is string => typeof item === 'string' && /^dos_[A-Za-z0-9_-]{16,80}$/.test(item)) : [];
        const removes = known.filter((endpointId) => !activeIds.has(endpointId));
        return { adds, removes, known };
      }, 2, { timeoutMs: 6000, maxWaitMs: 2000 });
      if (!pending || (pending.adds.length === 0 && pending.removes.length === 0)) continue;
      if (!(await refreshLinkToken(link.id))) { result.failed += 1; continue; }
      const token = await prisma.alexaNativeLink.findUnique({ where: { id: link.id }, select: { accessTokenCiphertext: true } });
      let accessToken = '';
      try { accessToken = token?.accessTokenCiphertext ? decryptPlatformEnvelope(token.accessTokenCiphertext) : ''; }
      catch (error) { if (error instanceof PlatformDataEncryptionKeyError) throw error; }
      if (!accessToken || accessToken.length < 16 || accessToken.length > 8192) { result.failed += 1; continue; }
      const post = async (name: 'AddOrUpdateReport' | 'DeleteReport', endpoints: JsonObject[]) => {
        const response = await fetch(eventGatewayEndpoint(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ event: { header: { namespace: 'Alexa.Discovery', name, messageId: `dinodia-${randomUUID()}`, payloadVersion: '3' },
            payload: { endpoints, scope: { type: 'BearerToken', token: accessToken } } } }),
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS), redirect: 'manual' });
        if (response.ok) { await response.body?.cancel().catch(() => {}); return true; }
        // Operator log: Amazon's status and error code only, never the body, token or endpoint ids.
        const code = await response.text().then((text) => /"code"\s*:\s*"([A-Z_]{3,60})"/.exec(text)?.[1] ?? '').catch(() => '');
        console.warn(`[alexa-gateway] ${name} refused status=${response.status}${code ? ` code=${code}` : ''}`);
        return false;
      };
      const rememberAnnounced = (change: (known: string[]) => string[]) => serializableTransaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AlexaNativeLink" WHERE "id" = ${link.id}::uuid FOR UPDATE`;
        const fresh = await tx.alexaNativeLink.findUnique({ where: { id: link.id }, select: { announcedEndpointIds: true } });
        const current = Array.isArray(fresh?.announcedEndpointIds) ? fresh.announcedEndpointIds.filter((item): item is string => typeof item === 'string') : [];
        const next = [...new Set(change(current))].slice(-5000);
        await tx.alexaNativeLink.update({ where: { id: link.id }, data: { announcedEndpointIds: next.length ? (next as Prisma.InputJsonValue) : Prisma.DbNull } });
      }, 2, { timeoutMs: 6000, maxWaitMs: 2000 });
      const addBatch = pending.adds.slice(0, MAX_ENDPOINTS_PER_REPORT);
      if (addBatch.length && await post('AddOrUpdateReport', addBatch.map((row) => row.endpoint))) {
        const addedIds = addBatch.map((row) => String(row.endpoint.endpointId ?? '')).filter(Boolean);
        await rememberAnnounced((known) => [...known, ...addedIds]);
        for (const row of addBatch) {
          // Bookkeeping only: one row that changed in the meantime is simply re-announced on the next tick.
          await prisma.alexaNativeEndpointProjection.updateMany({ where: { id: row.id, payloadHash: row.hash, status: 'ACTIVE' }, data: { announcedHash: row.hash, announcedAt: now } }).catch(() => undefined);
        }
        result.added += addBatch.length;
      } else if (addBatch.length) result.failed += 1;
      const removeBatch = pending.removes.slice(0, MAX_ENDPOINTS_PER_REPORT);
      if (removeBatch.length && await post('DeleteReport', removeBatch.map((endpointId) => ({ endpointId })))) {
        const gone = new Set(removeBatch);
        await rememberAnnounced((known) => known.filter((endpointId) => !gone.has(endpointId)));
        result.removed += removeBatch.length;
      } else if (removeBatch.length) result.failed += 1;
    } catch (error) {
      if (error instanceof PlatformDataEncryptionKeyError) throw error;
      result.failed += 1; // never log identifiers or the gateway body
    } finally {
      // Rotate this link to the back of the queue even when its sync failed, so one broken link cannot starve the others.
      await prisma.alexaNativeLink.updateMany({ where: { id: link.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }
  }
  return result;
}
