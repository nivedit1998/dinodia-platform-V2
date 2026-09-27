import { Stage1AuthError } from './stage1Auth';
import { validateLanEndpointObservation as validateCanonicalLanEndpointObservation } from './contracts/dinodiaV1';

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

export function validateLanEndpointObservation(value: unknown, serial: string, expectedPort = 8123): LanEndpointObservation {
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
  if (!match || Number(match[2]) !== expectedPort || match[2] !== String(expectedPort) || !privateIpv4(match[1])) {
    fail('lan_endpoint_url_invalid', 'The LAN endpoint must be the selected private IPv4 address on the approved OS port');
  }
  if (!validateCanonicalLanEndpointObservation(value, serial, expectedPort)) fail('lan_endpoint_invalid', 'The LAN endpoint does not match the canonical dinodia.v1 contract');
  return { version: 1, revision: Number(input.revision), state: 'CURRENT', baseUrl, discoveryHost: expectedDiscoveryHost };
}

export function lanEndpointFresh(state: string, reportedAt: Date | null, now = Date.now(), maxAgeMs = 420_000): boolean {
  return state === 'CURRENT' && reportedAt instanceof Date && Number.isFinite(reportedAt.getTime())
    && reportedAt.getTime() <= now && now - reportedAt.getTime() <= maxAgeMs;
}
