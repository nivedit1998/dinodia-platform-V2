import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { serializableTransaction } from '@/lib/serializableTransaction';
import {
  alexaOAuthApprovalPage, alexaOAuthConfig, alexaOAuthRequestProblem, authorizationCodeChallenge, alexaOAuthEntryPage, alexaOAuthErrorPage, alexaOAuthWaitingPage,
  isAlexaOAuthEnabled, lockAndValidateAlexaConnectIntent, parseAlexaOAuthForm,
  parseAlexaOAuthRequest,
} from '@/lib/nativeAlexaOAuth';
import { alexaSignInStatus, completeAlexaSignIn, startAlexaSignIn, type AlexaSignInFailure } from '@/lib/alexa/signInLinking';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

const SIGN_IN_NOTICES: Record<AlexaSignInFailure, { text: string; status: number }> = {
  INVALID: { text: 'That email or password is not right. Please try again.', status: 200 },
  SETUP_REQUIRED: { text: 'Finish setting up your account in the Dinodia Smart Living app first, then try again.', status: 200 },
  NOT_TENANT: { text: 'Alexa is available to tenants. This account is not a tenant of a Dinodia home, so it cannot be linked.', status: 200 },
  NO_PHONE: { text: 'Open the Dinodia Smart Living app on your phone and sign in once, then try again. Your phone is used to approve this.', status: 200 },
  RATE_LIMITED: { text: 'Too many attempts. Please wait a few minutes and try again.', status: 429 },
  UNAVAILABLE: { text: 'Something went wrong. Please try again in a moment.', status: 200 },
};

export async function GET(request: Request) {
  if (!isAlexaOAuthEnabled()) return alexaOAuthErrorPage(503);
  const config = alexaOAuthConfig();
  if (!config) return alexaOAuthErrorPage(503);
  try {
    const oauth = parseAlexaOAuthRequest(new URL(request.url).searchParams, config);
    return alexaOAuthEntryPage(oauth);
  } catch {
    console.warn(`[alexa-authorize] rejected ${alexaOAuthRequestProblem(new URL(request.url).searchParams, config)}`);
    return alexaOAuthErrorPage(400);
  }
}

const OAUTH_KEYS = ['client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method'];

/** Sign-in on the Alexa page: email and password, then approval on the tenant's phone. */
async function handleSignInFamily(raw: string, config: NonNullable<ReturnType<typeof alexaOAuthConfig>>): Promise<Response> {
  if (Buffer.byteLength(raw, 'utf8') > 8192) return alexaOAuthErrorPage(400);
  const values = new URLSearchParams(raw);
  const allowed = new Set([...OAUTH_KEYS, 'action', 'email', 'password', 'connect_intent']);
  if ([...values.keys()].some((key) => !allowed.has(key)) || [...new Set(values.keys())].some((key) => values.getAll(key).length !== 1)) return alexaOAuthErrorPage(400);
  const oauthValues = new URLSearchParams();
  for (const key of OAUTH_KEYS) for (const value of values.getAll(key)) oauthValues.append(key, value);
  let oauth;
  try { oauth = parseAlexaOAuthRequest(oauthValues, config); } catch { return alexaOAuthErrorPage(400); }
  const action = values.get('action');

  if (action === 'signin') {
    if (values.has('connect_intent')) return alexaOAuthErrorPage(400);
    const started = await startAlexaSignIn({ email: values.get('email'), password: values.get('password'), request: oauth });
    if (!started.ok) {
      const notice = SIGN_IN_NOTICES[started.reason];
      return alexaOAuthEntryPage(oauth, notice.text, notice.status);
    }
    return alexaOAuthWaitingPage(oauth, started.rawIntent, started.approvalNumber);
  }

  const rawIntent = values.get('connect_intent') ?? '';
  if (values.has('email') || values.has('password') || !rawIntent) return alexaOAuthErrorPage(400);
  const current = await alexaSignInStatus(rawIntent, oauth);

  if (action === 'status') {
    return NextResponse.json({ status: current.status }, { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } });
  }
  if (action === 'complete') {
    if (current.status === 'PENDING' && current.approvalNumber !== null) return alexaOAuthWaitingPage(oauth, rawIntent, current.approvalNumber);
    if (current.status === 'DECLINED') return alexaOAuthEntryPage(oauth, 'The request was declined on your phone. No access was granted.');
    if (current.status !== 'APPROVED') return alexaOAuthEntryPage(oauth, 'That request has expired. Please sign in again.');
    const rawCode = await completeAlexaSignIn(rawIntent, oauth, config.clientId);
    if (!rawCode) return alexaOAuthEntryPage(oauth, 'That request has expired. Please sign in again.');
    const callback = new URL(oauth.redirectUri);
    callback.searchParams.set('code', rawCode);
    callback.searchParams.set('state', oauth.state);
    return NextResponse.redirect(callback, { status: 303, headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' } });
  }
  return alexaOAuthErrorPage(400);
}

export async function POST(request: Request) {
  if (!isAlexaOAuthEnabled()) return alexaOAuthErrorPage(503);
  const config = alexaOAuthConfig();
  if (!config || !String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return alexaOAuthErrorPage(400);
  try {
    const rawBody = await request.text();
    if (new URLSearchParams(rawBody).has('action')) return await handleSignInFamily(rawBody, config);
    const parsed = parseAlexaOAuthForm(rawBody, config);
    const intentHash = sha256(parsed.connectIntent);
    const hint = await prisma.alexaNativeConnectIntent.findUnique({ where: { intentHash }, select: { id: true, kind: true } });
    if (!hint || hint.kind !== 'APP_CODE') return alexaOAuthErrorPage(400);
    if (!parsed.approve) {
      const preview = await serializableTransaction(async (tx) => lockAndValidateAlexaConnectIntent(tx, hint.id, 'unused'), 2);
      return alexaOAuthApprovalPage(parsed.request, parsed.connectIntent, { postcode: preview.postcode, areaNames: preview.areaNames });
    }

    const rawCode = randomSecret(32);
    const codeHash = sha256(rawCode);
    await serializableTransaction(async (tx) => {
      const current = await lockAndValidateAlexaConnectIntent(tx, hint.id, 'unused');
      const expiresAt = new Date(current.now.getTime() + 5 * 60 * 1000);
      const code = await tx.alexaOAuthAuthorizationCode.create({ data: {
        customerAccountId: current.intent.customerAccountId,
        clientId: parsed.request.clientId,
        redirectUri: parsed.request.redirectUri,
        codeChallenge: authorizationCodeChallenge(parsed.request, rawCode),
        codeChallengeMethod: 'S256',
        codeHash,
        expiresAt,
      }, select: { id: true } });
      await tx.alexaOAuthAuthorizationCodeIntent.create({ data: { authorizationCodeId: code.id, intentId: current.intent.id } });
      const consumed = await tx.alexaNativeConnectIntent.updateMany({
        where: { id: current.intent.id, intentHash, consumedAt: null, revokedAt: null, expiresAt: { gt: current.now } },
        data: { consumedAt: current.now },
      });
      if (consumed.count !== 1) throw new Error('Alexa connect intent lost its one-use race');
    }, 2);

    const callback = new URL(parsed.request.redirectUri);
    callback.searchParams.set('code', rawCode);
    callback.searchParams.set('state', parsed.request.state);
    return NextResponse.redirect(callback, { status: 303, headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' } });
  } catch {
    return alexaOAuthErrorPage(400);
  }
}
