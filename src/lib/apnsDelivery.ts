import crypto from 'node:crypto';
import { connect, constants as http2Constants } from 'node:http2';

export type ApnsEnvironment = 'DEVELOPMENT' | 'PRODUCTION';
export type ApnsResult = { outcome: 'ACCEPTED' } | { outcome: 'INVALID_TOKEN' } | { outcome: 'RETRY' } | { outcome: 'FAILED' };
export type ApnsConfig = { teamId: string; keyId: string; privateKey: crypto.KeyObject };

const APNS_TOPIC = 'com.dinodia.DinodiaV2';
const TOKEN_PATTERN = /^(?:[A-Fa-f0-9]{2}){32,256}$/;
let cachedProviderToken: { cacheKey: string; issuedAt: number; token: string } | null = null;

export function readApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const teamId = String(env.APNS_TEAM_ID ?? '').trim();
  const keyId = String(env.APNS_KEY_ID ?? '').trim();
  const source = String(env.APNS_AUTH_KEY_P8 ?? '').replace(/\\n/g, '\n').trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || source.length > 8192) return null;
  try {
    const privateKey = crypto.createPrivateKey(source);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return { teamId, keyId, privateKey };
  } catch { return null; }
}

export function createApnsProviderToken(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new Error('APNs clock invalid');
  const pemDigest = crypto.createHash('sha256').update(config.privateKey.export({ type: 'pkcs8', format: 'der' })).digest('hex');
  const cacheKey = `${config.teamId}:${config.keyId}:${pemDigest}`;
  const ageSeconds = cachedProviderToken ? nowSeconds - cachedProviderToken.issuedAt : -1;
  if (cachedProviderToken?.cacheKey === cacheKey && ageSeconds >= 0 && ageSeconds < 50 * 60) return cachedProviderToken.token;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: config.keyId })}.${encode({ iss: config.teamId, iat: nowSeconds })}`;
  const signer = crypto.createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const token = `${unsigned}.${signer.sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  cachedProviderToken = { cacheKey, issuedAt: nowSeconds, token };
  return token;
}

type ApnsRequest = { host: string; path: string; headers: Record<string, string>; body: string };
type ApnsResponse = { status: number; reason?: string };
type ApnsPoster = (input: ApnsRequest) => Promise<ApnsResponse>;

async function postHttp2(input: ApnsRequest): Promise<ApnsResponse> {
  const session = connect(`https://${input.host}`);
  return await new Promise((resolve) => {
    let done = false;
    let status = 0;
    let body = '';
    const finish = (response: ApnsResponse) => {
      if (done) return;
      done = true;
      try { session.close(); } catch { session.destroy(); }
      resolve(response);
    };
    session.once('error', () => finish({ status }));
    const stream = session.request(input.headers);
    stream.setEncoding('utf8');
    stream.setTimeout(8_000, () => { stream.close(http2Constants.NGHTTP2_CANCEL); finish({ status }); });
    stream.once('response', (headers) => { status = Number(headers[':status'] ?? 0); });
    stream.on('data', (chunk: string) => { if (body.length < 1024) body += chunk.slice(0, 1024 - body.length); });
    stream.once('error', () => finish({ status }));
    stream.once('end', () => {
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(body) as { reason?: unknown };
        if (typeof parsed.reason === 'string' && /^[A-Za-z0-9]{1,64}$/.test(parsed.reason)) reason = parsed.reason;
      } catch { /* Empty APNs success response is expected. */ }
      finish({ status, reason });
    });
    stream.end(input.body);
  });
}

/** Sends only a generic, non-household-specific completion alert. The token is never logged or returned. */
export async function sendInstallationCompletePush(input: {
  config: ApnsConfig; environment: ApnsEnvironment; deviceToken: string; requestId: string; expiresAt: Date;
}, poster: ApnsPoster = postHttp2): Promise<ApnsResult> {
  if (!TOKEN_PATTERN.test(input.deviceToken) || !/^[0-9a-f-]{36}$/i.test(input.requestId)
    || !Number.isFinite(input.expiresAt.getTime())) return { outcome: 'FAILED' };
  const host = input.environment === 'DEVELOPMENT' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  let response: ApnsResponse;
  try {
    response = await poster({
      host,
      path: `/3/device/${input.deviceToken.toLowerCase()}`,
      headers: {
        ':method': 'POST', ':path': `/3/device/${input.deviceToken.toLowerCase()}`,
        'content-type': 'application/json', authorization: `bearer ${createApnsProviderToken(input.config)}`,
        'apns-topic': APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(input.expiresAt.getTime() / 1000)),
        'apns-collapse-id': input.requestId,
      },
      body: JSON.stringify({ aps: { alert: { title: 'Installation update', body: 'A permanent-device installation request is complete.' }, sound: 'default' } }),
    });
  } catch { return { outcome: 'RETRY' }; }
  if (response.status === 200) return { outcome: 'ACCEPTED' };
  if (response.status === 410 || response.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(response.reason ?? '')) return { outcome: 'INVALID_TOKEN' };
  if (response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500) return { outcome: 'RETRY' };
  return { outcome: 'FAILED' };
}
