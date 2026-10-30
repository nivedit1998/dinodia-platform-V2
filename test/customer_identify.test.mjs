import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/customerIdentify.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, (id) => id === './prisma' ? { prisma: {} } : require(id));
const { identifyCustomerEmail } = isolated.exports;

const store = ({ account = null, invitation = null } = {}) => ({
  customerAccount: { findUnique: async () => account },
  membershipInvitation: { findFirst: async (args) => { store.lastInvitationQuery = args.where; return invitation; } },
});
const now = new Date('2026-10-30T12:00:00Z');

test('an unknown email with no invitation creates an account', async () => {
  assert.equal(await identifyCustomerEmail('a@example.com', now, store()), 'CREATE_ACCOUNT');
});

test('an unverified account is told to verify its email, whatever else is true', async () => {
  assert.equal(await identifyCustomerEmail('a@example.com', now, store({ account: { emailVerifiedAt: null, mustChangePassword: false }, invitation: { id: 'x' } })), 'VERIFY_EMAIL');
});

test('a verified account signs in', async () => {
  assert.equal(await identifyCustomerEmail('a@example.com', now, store({ account: { emailVerifiedAt: now, mustChangePassword: false } })), 'SIGN_IN');
});

test('an account still holding an invitation one-time password is asked for it', async () => {
  assert.equal(await identifyCustomerEmail('a@example.com', now, store({ account: { emailVerifiedAt: now, mustChangePassword: true } })), 'ONE_TIME_PASSWORD');
});

test('a tenant invited without an account is asked for the one-time password; the query is only for live tenant invitations that carry one', async () => {
  const dependencies = store({ invitation: { id: 'invitation' } });
  assert.equal(await identifyCustomerEmail('a@example.com', now, dependencies), 'ONE_TIME_PASSWORD');
  assert.deepEqual(store.lastInvitationQuery, {
    targetEmailNormalized: 'a@example.com', role: 'TENANT', state: 'PENDING', expiresAt: { gt: now }, temporaryCredentialHash: { not: null },
  });
});
