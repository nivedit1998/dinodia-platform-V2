import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/contracts/nativeV1Error.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, loaded, loaded.exports);
const { nativeV1ErrorResponse } = loaded.exports;

test('Native V1 auth errors use the canonical nested error envelope and preserve HTTP status', async () => {
  const response = nativeV1ErrorResponse({ status: 401, code: 'customer_session_required', message: 'A customer session is required' });
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.equal(body.error.message, 'A customer session is required');
  assert.match(body.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(body.error.retryable, false);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
});

test('Native V1 maps expiry, scope, freshness and infrastructure failures to canonical codes', async () => {
  for (const [failure, expected] of [
    [{ status: 401, code: 'customer_session_invalid', message: 'Expired' }, 'TOKEN_EXPIRED'],
    [{ status: 401, code: 'customer_access_token_expired', message: 'Refresh required' }, 'CUSTOMER_ACCESS_EXPIRED'],
    [{ status: 403, code: 'home_membership_forbidden', message: 'Wrong home' }, 'SCOPE_DENIED'],
    [{ status: 401, code: 'area_policy_stale', message: 'Refresh' }, 'UPDATE_REQUIRED'],
    [{ status: 409, code: 'claim_policy_required', message: 'Accept the current customer policy' }, 'UPDATE_REQUIRED'],
    [{ status: 409, code: 'claim_address_confirmation_required', message: 'Confirm the current address' }, 'REVISION_CONFLICT'],
    [{ status: 409, code: 'FINAL_RELATIONSHIP_CONFIRMATION_REQUIRED', message: 'Confirm whole-account deletion' }, 'FINAL_RELATIONSHIP_CONFIRMATION_REQUIRED'],
    [{ status: 409, code: 'claim_reservation_expired', message: 'The claim expired' }, 'RESOURCE_NOT_FOUND'],
    [{ status: 503, code: 'home_hub_unavailable', message: 'Offline' }, 'HUB_UNAVAILABLE'],
  ]) {
    const response = nativeV1ErrorResponse(failure);
    assert.equal((await response.json()).error.code, expected);
    assert.equal(response.status, failure.status);
  }
});

test('Native V1 hides unexpected error details and emits an explicit internal code', async () => {
  const response = nativeV1ErrorResponse(new Error('private request body and token must not escape'));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'The request could not be completed');
  assert.doesNotMatch(JSON.stringify(body), /private request body|token must not escape/);
});
