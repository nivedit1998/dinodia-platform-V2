import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { serializableTransaction } from '@/lib/serializableTransaction';
import {
  alexaOAuthApprovalPage, alexaOAuthConfig, alexaOAuthEntryPage, alexaOAuthErrorPage,
  isAlexaOAuthEnabled, lockAndValidateAlexaConnectIntent, parseAlexaOAuthForm,
  parseAlexaOAuthRequest,
} from '@/lib/nativeAlexaOAuth';
import { randomSecret, sha256 } from '@/lib/stage1Crypto';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAlexaOAuthEnabled()) return alexaOAuthErrorPage(503);
  const config = alexaOAuthConfig();
  if (!config) return alexaOAuthErrorPage(503);
  try {
    const oauth = parseAlexaOAuthRequest(new URL(request.url).searchParams, config);
    return alexaOAuthEntryPage(oauth);
  } catch {
    return alexaOAuthErrorPage(400);
  }
}

export async function POST(request: Request) {
  if (!isAlexaOAuthEnabled()) return alexaOAuthErrorPage(503);
  const config = alexaOAuthConfig();
  if (!config || !String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return alexaOAuthErrorPage(400);
  try {
    const parsed = parseAlexaOAuthForm(await request.text(), config);
    const intentHash = sha256(parsed.connectIntent);
    const hint = await prisma.alexaNativeConnectIntent.findUnique({ where: { intentHash }, select: { id: true } });
    if (!hint) return alexaOAuthErrorPage(400);
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
        codeChallenge: parsed.request.codeChallenge,
        codeChallengeMethod: parsed.request.codeChallengeMethod,
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
