import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { Stage1AuthError } from '@/lib/stage1Auth';
import { currentCustomerPolicy } from '@/lib/customerPolicyConfig';
import { sha256 } from '@/lib/stage1Crypto';

export const ALEXA_OAUTH_ACCESS_SECONDS = 60 * 60;
export const ALEXA_OAUTH_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
export const ALEXA_OAUTH_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1000;
export const ALEXA_OAUTH_CODE_MS = 5 * 60 * 1000;
export const ALEXA_OAUTH_SCOPE = 'alexa::skills:account_linking';

export type AlexaOAuthRequest = {
  clientId: string;
  redirectUri: string;
  responseType: 'code';
  state: string;
  scope: string;
  /** Alexa's plain authorization-code grant sends no PKCE; the confidential client secret protects the code exchange then. */
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | null;
};

export type AlexaOAuthConfig = { clientId: string; clientSecret: string; redirectUris: Set<string>; scope: string };

export function alexaOAuthConfig(): AlexaOAuthConfig | null {
  const clientId = String(process.env.DINODIA_ALEXA_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.DINODIA_ALEXA_OAUTH_CLIENT_SECRET ?? '');
  const redirectUris = String(process.env.DINODIA_ALEXA_OAUTH_REDIRECT_URIS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const scope = String(process.env.DINODIA_ALEXA_OAUTH_SCOPE ?? ALEXA_OAUTH_SCOPE).trim();
  if (!clientId || clientId.length > 160 || clientSecret.length < 16 || clientSecret.length > 512 || redirectUris.length === 0 || redirectUris.length > 20
    || scope !== ALEXA_OAUTH_SCOPE || redirectUris.some((value) => !isSafeRedirectUri(value))) return null;
  return { clientId, clientSecret, redirectUris: new Set(redirectUris), scope };
}

/** Require the exact HTTP Basic client authentication configured for Alexa. */
export function alexaOAuthClientAuthenticated(request: Request, values: URLSearchParams, config: AlexaOAuthConfig): boolean {
  if (values.has('client_secret')) return false;
  const bodyClientId = values.getAll('client_id');
  if (bodyClientId.length > 1 || (bodyClientId.length === 1 && bodyClientId[0] !== config.clientId)) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
  if (!match) return false;
  let decoded: string;
  try {
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64') !== match[1]) return false;
    decoded = bytes.toString('utf8');
  } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 1 || decoded.slice(0, separator) !== config.clientId) return false;
  const presented = crypto.createHash('sha256').update(decoded, 'utf8').digest();
  const expected = crypto.createHash('sha256').update(`${config.clientId}:${config.clientSecret}`, 'utf8').digest();
  return crypto.timingSafeEqual(presented, expected);
}

export function isAlexaOAuthEnabled(): boolean {
  return process.env.DINODIA_NATIVE_ALEXA_ENABLED === 'true';
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && value.length <= 500;
  } catch { return false; }
}

export function parseAlexaOAuthRequest(values: URLSearchParams, config: AlexaOAuthConfig): AlexaOAuthRequest {
  const required = ['client_id', 'redirect_uri', 'response_type', 'state', 'scope'];
  const optional = ['code_challenge', 'code_challenge_method'];
  // Amazon may add parameters of its own; only the known ones are read and carried forward.
  if (required.some((key) => values.getAll(key).length !== 1)
    || optional.some((key) => values.getAll(key).length > 1)
    || values.has('code_challenge') !== values.has('code_challenge_method')) {
    throw new Stage1AuthError(400, 'alexa_oauth_request_invalid', 'The Alexa account-link request is invalid');
  }
  const request = {
    clientId: values.get('client_id') ?? '',
    redirectUri: values.get('redirect_uri') ?? '',
    responseType: values.get('response_type') ?? '',
    state: values.get('state') ?? '',
    scope: values.get('scope') ?? '',
    codeChallenge: values.get('code_challenge'),
    codeChallengeMethod: values.get('code_challenge_method'),
  };
  if (request.clientId !== config.clientId || !config.redirectUris.has(request.redirectUri)
    || request.responseType !== 'code' || request.scope !== config.scope
    || !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(request.state)
    || (request.codeChallenge !== null && !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge))
    || (request.codeChallengeMethod !== null && request.codeChallengeMethod !== 'S256')) {
    throw new Stage1AuthError(400, 'alexa_oauth_request_invalid', 'The Alexa account-link request is invalid');
  }
  return request as AlexaOAuthRequest;
}

/** Stored in place of a PKCE challenge when the client used the plain code grant; derivable only from the code itself. */
export function noPkceChallenge(rawCode: string): string {
  return crypto.createHash('sha256').update(`dinodia-alexa-no-pkce\0${rawCode}`).digest('base64url');
}

export function authorizationCodeChallenge(request: AlexaOAuthRequest, rawCode: string): string {
  return request.codeChallenge ?? noPkceChallenge(rawCode);
}

export function parseAlexaOAuthForm(raw: string, config: AlexaOAuthConfig): { request: AlexaOAuthRequest; connectIntent: string; approve: boolean } {
  if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Stage1AuthError(400, 'alexa_oauth_request_invalid', 'The Alexa account-link request is invalid');
  const values = new URLSearchParams(raw);
  const intentValues = values.getAll('connect_intent');
  const approveValues = values.getAll('approve');
  const oauthValues = new URLSearchParams();
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method']) {
    for (const value of values.getAll(key)) oauthValues.append(key, value);
  }
  if (intentValues.length !== 1 || approveValues.length > 1
    || [...values.keys()].some((key) => !['connect_intent', 'approve', 'client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method'].includes(key))) {
    throw new Stage1AuthError(400, 'alexa_oauth_request_invalid', 'The Alexa account-link request is invalid');
  }
  const connectIntent = intentValues[0] ?? '';
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(connectIntent)
    || (approveValues.length === 1 && approveValues[0] !== 'authorize')) {
    throw new Stage1AuthError(400, 'alexa_oauth_request_invalid', 'The Alexa account-link request is invalid');
  }
  return { request: parseAlexaOAuthRequest(oauthValues, config), connectIntent, approve: approveValues[0] === 'authorize' };
}

export function escapeAlexaHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function hiddenFields(request: AlexaOAuthRequest, connectIntent?: string, approve = false): string {
  const fields: Array<[string, string]> = [
    ['client_id', request.clientId], ['redirect_uri', request.redirectUri], ['response_type', request.responseType],
    ['state', request.state], ['scope', request.scope],
  ];
  if (request.codeChallenge !== null && request.codeChallengeMethod !== null) {
    fields.push(['code_challenge', request.codeChallenge], ['code_challenge_method', request.codeChallengeMethod]);
  }
  if (connectIntent !== undefined) fields.push(['connect_intent', connectIntent]);
  if (approve) fields.push(['approve', 'authorize']);
  return fields.map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeAlexaHtml(value)}">`).join('');
}

const PAGE_STYLE = ':root{color-scheme:light dark}body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#14181f}main{max-width:420px;margin:0 auto;padding:32px 20px}section>p:first-child{margin:0 0 4px;font-size:12px;letter-spacing:.14em;color:#5b6472}h1{margin:0 0 12px;font-size:24px;line-height:1.2}label{display:block;margin:16px 0 6px;font-weight:600}input:not([type=hidden]){box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c0cc;border-radius:10px;font-size:16px;background:#fff;color:#14181f}button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:10px;background:#1f5eff;color:#fff;font-size:17px;font-weight:600}.notice{padding:12px;border-radius:10px;background:#fdecea;color:#7a1c14}.number{margin:20px 0;text-align:center;font-size:56px;font-weight:700;letter-spacing:.08em}.muted{color:#5b6472;font-size:14px}@media (prefers-color-scheme:dark){body{background:#0e1116;color:#f1f3f7}input:not([type=hidden]){background:#1a1f27;color:#f1f3f7;border-color:#3a4250}.notice{background:#3a1814;color:#ffd7d2}.muted,section>p:first-child{color:#9aa3b2}}';

function page(content: string, status = 200, script?: string): Response {
  const nonce = script ? crypto.randomBytes(16).toString('base64') : '';
  const scriptPolicy = script ? `; script-src 'nonce-${nonce}'; connect-src 'self'` : '';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect Alexa — Dinodia Smart Living</title><style>${PAGE_STYLE}</style></head><body><main>${content}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${scriptPolicy}; base-uri 'none'; frame-ancestors 'none'` },
  });
}

export function alexaOAuthEntryPage(request: AlexaOAuthRequest, notice?: string, status = 200): Response {
  const message = notice ? `<p class="notice" role="alert">${escapeAlexaHtml(notice)}</p>` : '';
  return page(`<section><p>DINODIA SMART LIVING</p><h1>Connect Dinodia to Alexa</h1><p>Sign in with the email and password you use in the Dinodia Smart Living app. You will then approve this on your phone. Alexa will only see the devices in the rooms you have access to as a tenant.</p>${message}<form method="post" autocomplete="on">${hiddenFields(request)}<input type="hidden" name="action" value="signin"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="320" autocomplete="email" autocapitalize="none" spellcheck="false" inputmode="email"><label for="password">Password</label><input id="password" name="password" type="password" required maxlength="1024" autocomplete="current-password"><button type="submit">Continue</button></form><p class="muted">Dinodia will never ask for your password anywhere else, and Alexa never sees it.</p></section>`, status);
}

export function alexaOAuthWaitingPage(request: AlexaOAuthRequest, connectIntent: string, approvalNumber: number): Response {
  const fields = hiddenFields(request, connectIntent);
  // Only the "go" form is ever submitted from here (it carries the one-time request, never the password): it shows the right message for approved, declined or expired.
  const script = `var f=document.getElementById('go');var t=Date.now();function done(){f.submit()}function poll(){if(Date.now()-t>300000){done();return}fetch(location.pathname,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(document.getElementById('st'))).toString(),credentials:'omit',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.status==='PENDING'){setTimeout(poll,2000)}else{done()}}).catch(function(){setTimeout(poll,4000)})}setTimeout(poll,1500);`;
  return page(`<section><p>DINODIA SMART LIVING</p><h1>Approve on your phone</h1><p>Open the Dinodia Smart Living app on your phone and tap this number when asked:</p><div class="number" aria-live="polite">${approvalNumber}</div><p class="muted">Only approve if this number matches. This page continues by itself once you approve. If you did not start this, choose "No, it's not me" on your phone.</p><form id="st" method="post">${fields}<input type="hidden" name="action" value="status"></form><form id="go" method="post">${fields}<input type="hidden" name="action" value="complete"><noscript><button type="submit">I have approved on my phone</button></noscript></form></section>`, 200, script);
}

export function alexaOAuthApprovalPage(request: AlexaOAuthRequest, connectIntent: string, scope: { postcode: string | null; areaNames: string[] }): Response {
  const location = scope.postcode ? `Property postcode: ${escapeAlexaHtml(scope.postcode)}` : 'Property postcode is not currently available.';
  const areas = scope.areaNames.map(escapeAlexaHtml).join(', ');
  return page(`<section><p>DINODIA SMART LIVING</p><h1>Review Alexa access</h1><p>Alexa will be able to use supported controls only within the tenant Areas selected in Dinodia. Dinodia will re-check membership and permissions for every request.</p><p>${location}</p><p>Selected Areas: ${areas}</p><p>This does not share locks or security controls, and does not authorize another Home or another tenant's devices.</p><form method="post">${hiddenFields(request, connectIntent, true)}<button type="submit">Authorize Alexa account linking</button></form><p>You can close this page to cancel. No access is granted until you authorize.</p></section>`);
}

export function alexaOAuthErrorPage(status = 400): Response {
  return page('<section><p>DINODIA SMART LIVING</p><h1>Connection could not be completed</h1><p>Return to the Dinodia app, refresh the Alexa page and start a new connection if needed. No access was granted.</p></section>', status);
}

export function alexaOAuthJsonError(error: 'invalid_request' | 'invalid_client' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_grant' | 'temporarily_unavailable' | 'server_error', status: number): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

export async function lockAndValidateAlexaConnectIntent(
  tx: Prisma.TransactionClient,
  intentId: string,
  expected: 'unused' | 'consumed',
) {
  const hint = await tx.alexaNativeConnectIntent.findUnique({ where: { id: intentId }, select: { customerAccountId: true, homeId: true, membershipId: true } });
  if (!hint) throw new Stage1AuthError(400, 'alexa_connect_intent_invalid', 'The Alexa connection request is no longer valid');
  await tx.$queryRaw`SELECT "id" FROM "Home" WHERE "id" = ${hint.homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${hint.customerAccountId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "HomeMembership" WHERE "id" = ${hint.membershipId}::uuid AND "customerAccountId" = ${hint.customerAccountId}::uuid AND "homeId" = ${hint.homeId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "TenantAreaGrant" WHERE "membershipId" = ${hint.membershipId}::uuid AND "homeId" = ${hint.homeId}::uuid ORDER BY "areaId" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "HubInstallation" WHERE "homeId" = ${hint.homeId}::uuid ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AlexaNativeConnectIntent" WHERE "id" = ${intentId}::uuid FOR UPDATE`;

  const intent = await tx.alexaNativeConnectIntent.findUnique({ where: { id: intentId }, select: {
    id: true, customerAccountId: true, homeId: true, membershipId: true, intentHash: true,
    expiresAt: true, consumedAt: true, revokedAt: true,
    customerAccount: { select: { id: true, status: true, emailVerifiedAt: true, mustChangePassword: true, usernameSelectionRequired: true } },
    membership: { select: { id: true, customerAccountId: true, homeId: true, role: true, status: true,
      home: { select: { lifecycle: true, installationStatus: true, activeHubInstallationId: true, postcode: true } },
      tenantAreaGrants: { where: { revokedAt: null, area: { status: 'ACTIVE' } }, select: { areaId: true } } } },
    areas: { orderBy: { areaId: 'asc' }, select: { areaId: true, area: { select: { homeId: true, status: true, originalName: true, overrideName: true } } } },
  } });
  const now = new Date();
  const currentPolicy = currentCustomerPolicy();
  const acceptedPolicy = currentPolicy ? await tx.policyAcceptance.findUnique({ where: { customerAccountId_policyKind_policyVersion: {
    customerAccountId: hint.customerAccountId, policyKind: 'DINODIA_NATIVE', policyVersion: currentPolicy.version,
  } }, select: { id: true } }) : null;
  const hubId = intent?.membership.home.activeHubInstallationId;
  const hub = hubId ? await tx.hubInstallation.findFirst({ where: { id: hubId, homeId: hint.homeId, lifecycleStatus: 'ACTIVE' }, select: { id: true } }) : null;
  const selectedAreas = intent?.areas.map((area) => area.areaId) ?? [];
  const grants = new Set(intent?.membership.tenantAreaGrants.map((grant) => grant.areaId) ?? []);
  const stateMatches = expected === 'unused' ? intent?.consumedAt === null : intent?.consumedAt !== null;
  if (!intent || intent.customerAccountId !== hint.customerAccountId || intent.homeId !== hint.homeId || intent.membershipId !== hint.membershipId
    || (expected === 'unused' && (intent.consumedAt || intent.revokedAt)) || (expected === 'consumed' && !intent.consumedAt)
    || !stateMatches || intent.revokedAt || intent.expiresAt <= now
    || intent.customerAccount.status !== 'ACTIVE' || !intent.customerAccount.emailVerifiedAt || intent.customerAccount.mustChangePassword || intent.customerAccount.usernameSelectionRequired
    || !acceptedPolicy || !currentPolicy
    || intent.membership.customerAccountId !== hint.customerAccountId || intent.membership.homeId !== hint.homeId
    || intent.membership.role !== 'TENANT' || intent.membership.status !== 'ACTIVE'
    || intent.membership.home.lifecycle !== 'ACTIVE' || intent.membership.home.installationStatus !== 'COMPLETE' || !hub
    || selectedAreas.length < 1 || selectedAreas.length > 200 || new Set(selectedAreas).size !== selectedAreas.length
    || selectedAreas.some((areaId) => !grants.has(areaId) || intent.areas.find((row) => row.areaId === areaId)?.area.homeId !== hint.homeId
      || intent.areas.find((row) => row.areaId === areaId)?.area.status !== 'ACTIVE')) {
    throw new Stage1AuthError(400, 'alexa_connect_intent_invalid', 'The Alexa connection request is no longer valid');
  }
  return { intent, selectedAreas, now, postcode: intent.membership.home.postcode,
    areaNames: intent.areas.map((row) => row.area.overrideName ?? row.area.originalName) };
}

export async function applyAlexaIntentScope(tx: Prisma.TransactionClient, input: {
  linkId: string; intentId: string; membershipId: string; homeId: string; selectedAreaIds: string[]; now: Date;
}) {
  let scope = await tx.alexaNativeHomeScope.findUnique({ where: { linkId_membershipId: {
    linkId: input.linkId, membershipId: input.membershipId,
  } }, select: { id: true, homeId: true, membershipId: true, revokedAt: true, exposureGeneration: true } });
  if (!scope) scope = await tx.alexaNativeHomeScope.create({ data: {
    linkId: input.linkId, homeId: input.homeId, membershipId: input.membershipId,
    // Legacy non-null column retained for compatibility only. All authority
    // comes from AlexaNativeAreaSelection rows created below.
    areaIds: [] as Prisma.InputJsonValue, exposureGeneration: 1,
  }, select: { id: true, homeId: true, membershipId: true, revokedAt: true, exposureGeneration: true } });
  else if (scope.revokedAt) scope = await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: {
    revokedAt: null, exposureGeneration: { increment: 1 }, updatedAt: input.now,
  }, select: { id: true, homeId: true, membershipId: true, revokedAt: true, exposureGeneration: true } });
  const activeSelections = await tx.alexaNativeAreaSelection.findMany({ where: { homeScopeId: scope.id, revokedAt: null }, select: { id: true, areaId: true, exposureGeneration: true } });
  const activeIds = new Set(activeSelections.map((row) => row.areaId));
  const desiredIds = new Set(input.selectedAreaIds);
  const removed = [...activeIds].filter((areaId) => !desiredIds.has(areaId));
  const added = [...desiredIds].filter((areaId) => !activeIds.has(areaId));
  if (removed.length) {
    await tx.alexaNativeAreaSelection.updateMany({ where: { homeScopeId: scope.id, areaId: { in: removed }, revokedAt: null }, data: { revokedAt: input.now, updatedAt: input.now } });
    await tx.alexaNativeEndpointProjection.updateMany({ where: { linkId: input.linkId, areaId: { in: removed }, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', updatedAt: input.now } });
  }
  for (const areaId of added) {
    const maximum = await tx.alexaNativeAreaSelection.aggregate({ where: { homeScopeId: scope.id, areaId }, _max: { exposureGeneration: true } });
    await tx.alexaNativeAreaSelection.create({ data: {
      homeScopeId: scope.id, areaId, exposureGeneration: Math.max(0, maximum._max.exposureGeneration ?? 0) + 1,
    } });
  }
  if (removed.length || added.length) {
    scope = await tx.alexaNativeHomeScope.update({ where: { id: scope.id }, data: {
      exposureGeneration: { increment: 1 }, updatedAt: input.now,
    }, select: { id: true, homeId: true, membershipId: true, revokedAt: true, exposureGeneration: true } });
  }
  return { scope, changed: removed.length > 0 || added.length > 0 };
}

export function makeAlexaOpaqueToken(kind: 'access' | 'refresh'): string {
  return `dno-alexa-${kind}-${crypto.randomBytes(32).toString('base64url')}`;
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function providerSubjectHash(clientId: string, accountId: string): string {
  // Alexa does not disclose a stable Amazon user identifier to a third-party
  // OAuth server. This opaque stable subject represents this one native skill
  // link per Dinodia account without persisting an email or voice identity.
  return sha256(`dinodia-native-alexa-v1\u0000${clientId}\u0000${accountId}`);
}
