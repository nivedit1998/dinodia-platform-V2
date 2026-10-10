import { Stage1AuthError } from './stage1Auth';
import { validateLanEndpointObservation as validateCanonicalLanEndpointObservation, validateLanTlsIdentityObservation as validateCanonicalLanTlsIdentityObservation } from './contracts/dinodiaV1';

export type LanEndpointObservation = {
  version: 1;
  revision: number;
  state: 'CURRENT' | 'UNAVAILABLE';
  baseUrl?: string;
  discoveryHost: string;
};

function privateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (octets.some((part, index) => String(part) !== value.split('.')[index])) return false;
  const [a, b, , d] = octets;
  if (d === 0 || d === 255) return false;
  if (a === 172 && (b === 17 || b === 18)) return false; // default Docker bridge/user network ranges are never hub LAN endpoints
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validateLanEndpointObservation(value: unknown, serial: string, expectedPort = 80): LanEndpointObservation {
  const fail = (code: string, message: string): never => { throw new Stage1AuthError(400, code, message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('lan_endpoint_invalid', 'The hub LAN endpoint observation is invalid');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['version', 'revision', 'state', 'baseUrl', 'discoveryHost']);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('lan_endpoint_invalid', 'The hub LAN endpoint observation contains an unsupported field');
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) fail('lan_endpoint_invalid', 'The hub LAN endpoint version or revision is invalid');
  const expectedDiscoveryHost = `dinodia-${String(serial).toLowerCase()}.local`;
  if (input.discoveryHost !== expectedDiscoveryHost || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(expectedDiscoveryHost)) fail('lan_endpoint_identity_mismatch', 'The hub discovery name does not match its registered identity');
  if (input.state === 'UNAVAILABLE') {
    if (Object.hasOwn(input, 'baseUrl')) fail('lan_endpoint_invalid', 'An unavailable LAN endpoint must not include a URL');
    if (!validateCanonicalLanEndpointObservation(value, serial, expectedPort)) fail('lan_endpoint_invalid', 'The LAN endpoint does not match the canonical dinodia.v1 contract');
    return { version: 1, revision: Number(input.revision), state: 'UNAVAILABLE', discoveryHost: expectedDiscoveryHost };
  }
  if (input.state !== 'CURRENT' || typeof input.baseUrl !== 'string') fail('lan_endpoint_invalid', 'The hub LAN endpoint state is invalid');
  const baseUrl = input.baseUrl as string;
  const match = baseUrl.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  const allowedPorts = expectedPort === 80 ? new Set(["80", "8123"]) : new Set([String(expectedPort)]);
  if (!match || !allowedPorts.has(match[2]) || !privateIpv4(match[1])) {
    fail('lan_endpoint_url_invalid', 'The LAN endpoint must be the selected private IPv4 address on the approved OS port');
  }
  if (!validateCanonicalLanEndpointObservation(value, serial, expectedPort)) fail('lan_endpoint_invalid', 'The LAN endpoint does not match the canonical dinodia.v1 contract');
  return { version: 1, revision: Number(input.revision), state: 'CURRENT', baseUrl, discoveryHost: expectedDiscoveryHost };
}

export function lanEndpointFresh(state: string, reportedAt: Date | null, now = Date.now(), maxAgeMs = 420_000): boolean {
  return state === 'CURRENT' && reportedAt instanceof Date && Number.isFinite(reportedAt.getTime())
    && reportedAt.getTime() <= now && now - reportedAt.getTime() <= maxAgeMs;
}

/** Return only the private address from a fresh, current-generation signed OS LAN observation. */
export function verifiedCustomerClaimLanAddress(input: {
  manufacturingIdentityGeneration: number;
  manufacturingIdentityStatus: string;
  lanEndpointState: string;
  lanEndpointReportedAt: Date | null;
  lanEndpointIdentityGeneration: number | null;
  baseUrl: string | null;
}, now: Date): string | undefined {
  if (input.manufacturingIdentityStatus !== 'ACTIVE'
    || !Number.isInteger(input.manufacturingIdentityGeneration)
    || input.lanEndpointIdentityGeneration !== input.manufacturingIdentityGeneration
    || !lanEndpointFresh(input.lanEndpointState, input.lanEndpointReportedAt, now.getTime())
    || typeof input.baseUrl !== 'string') return undefined;
  const match = input.baseUrl.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(80|8123)$/);
  if (!match || !privateIpv4(match[1])) return undefined;
  return match[1];
}

export function customerClaimLanAddressValidUntil(reportedAt: Date): Date {
  return new Date(reportedAt.getTime() + 420_000);
}

export type CurrentLanTlsIdentity = {
  manufacturingIdentityGeneration: number;
  manufacturingIdentityStatus: string;
  publicHubId: string | null;
  lanTlsReportedAt: Date | null;
  lanTlsState: string;
  lanTlsIdentityGeneration: number | null;
  lanTlsCertificateGeneration: number | null;
  lanTlsCurrentSpkiPin: string | null;
  lanTlsCurrentNotBefore: Date | null;
  lanTlsCurrentNotAfter: Date | null;
  lanTlsNextCertificateGeneration: number | null;
  lanTlsNextSpkiPin: string | null;
  lanTlsNextNotBefore: Date | null;
  lanTlsNextNotAfter: Date | null;
};

/**
 * Project a LAN endpoint only while its report is fresh and bound to the
 * currently enrolled manufacturing generation. A historical report is not
 * authority after identity rotation.
 */
export function verifiedCustomerLanEndpoint(hub: CurrentLanTlsIdentity, now: Date) {
  const reportedAt = hub.lanTlsReportedAt;
  if (hub.manufacturingIdentityStatus !== 'ACTIVE'
    || !Number.isInteger(hub.manufacturingIdentityGeneration)
    || hub.lanTlsIdentityGeneration !== hub.manufacturingIdentityGeneration
    || !hub.publicHubId || !/^[a-f0-9]{20}$/.test(hub.publicHubId) || hub.lanTlsState !== 'CURRENT'
    || !Number.isInteger(hub.lanTlsIdentityGeneration) || !Number.isInteger(hub.lanTlsCertificateGeneration)
    || !hub.lanTlsCurrentSpkiPin || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(hub.lanTlsCurrentSpkiPin)
    || !hub.lanTlsCurrentNotBefore || !hub.lanTlsCurrentNotAfter || !reportedAt || reportedAt > now
    || now.getTime() - reportedAt.getTime() > 420_000 || hub.lanTlsCurrentNotBefore > now || hub.lanTlsCurrentNotAfter <= now) return undefined;
  const nextFields = [hub.lanTlsNextCertificateGeneration, hub.lanTlsNextSpkiPin, hub.lanTlsNextNotBefore, hub.lanTlsNextNotAfter];
  const hasNext = nextFields.some((value) => value !== null);
  if (hasNext && (nextFields.some((value) => value === null) || !Number.isInteger(hub.lanTlsNextCertificateGeneration)
    || Number(hub.lanTlsNextCertificateGeneration) <= Number(hub.lanTlsCertificateGeneration)
    || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(String(hub.lanTlsNextSpkiPin))
    || hub.lanTlsNextNotBefore! > hub.lanTlsNextNotAfter!)) return undefined;
  const validUntil = new Date(reportedAt.getTime() + 420_000);
  return {
    state: 'verified_lan' as const,
    origin: `https://dinodia-${hub.publicHubId}.local:8123`,
    publicHubId: hub.publicHubId,
    certificateGeneration: Number(hub.lanTlsCertificateGeneration),
    currentSpkiPin: hub.lanTlsCurrentSpkiPin,
    currentNotBefore: hub.lanTlsCurrentNotBefore.toISOString(),
    currentNotAfter: hub.lanTlsCurrentNotAfter.toISOString(),
    ...(hasNext ? {
      nextCertificateGeneration: Number(hub.lanTlsNextCertificateGeneration),
      nextSpkiPin: hub.lanTlsNextSpkiPin!,
      nextNotBefore: hub.lanTlsNextNotBefore!.toISOString(),
      nextNotAfter: hub.lanTlsNextNotAfter!.toISOString(),
    } : {}),
    reportedAt: reportedAt.toISOString(),
    validUntil: validUntil.toISOString(),
  };
}

export function validateLanTlsIdentity(value: unknown, now = Date.now()): value is import('./contracts/dinodiaV1').LanTlsIdentityObservation {
  if (!validateCanonicalLanTlsIdentityObservation(value)) return false;
  const report = value as import('./contracts/dinodiaV1').LanTlsIdentityObservation;
  if (report.state !== 'CURRENT') return true;
  const currentNotBefore = Date.parse(report.currentNotBefore);
  const currentNotAfter = Date.parse(report.currentNotAfter);
  if (!Number.isFinite(now) || currentNotBefore > now || currentNotAfter <= now) return false;
  if (report.nextNotBefore && Date.parse(report.nextNotBefore) < now - 60_000) return false;
  return true;
}
