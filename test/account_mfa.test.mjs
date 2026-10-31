import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, stubs) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const isolated = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, (name) => (name in stubs ? stubs[name] : require(name)));
  return isolated.exports;
}
class Stage1AuthError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const mfa = load('src/lib/accountMfa.ts', {
  './prisma': { prisma: {} }, './rateLimit': {}, './stage1Auth': { Stage1AuthError }, './customerAuthEmail': {}, './serializableTransaction': {},
  './stage1Crypto': { sha256: (value) => `sha:${value}`, randomSecret: () => 'x'.repeat(43), constantTimeEqual: (a, b) => a === b },
  './noticeContent': { MFA_CODE_MINUTES: 10 },
});

test('who needs it: homeowners and property managers always, tenants only when they turned it on', async () => {
  const db = (roles, enabled) => ({ homeMembership: { findMany: async () => roles.map((role) => ({ role })) }, customerAccount: { findUnique: async () => ({ mfaEnabledAt: enabled ? new Date() : null }) } });
  assert.deepEqual(await mfa.accountMfaRequirement(db(['OWNER'], false), 'a'), { requirement: 'REQUIRED', reason: 'OWNER' });
  assert.deepEqual(await mfa.accountMfaRequirement(db(['PROPERTY_MANAGER'], false), 'a'), { requirement: 'REQUIRED', reason: 'PROPERTY_MANAGER' });
  assert.deepEqual(await mfa.accountMfaRequirement(db(['OWNER', 'PROPERTY_MANAGER'], true), 'a'), { requirement: 'REQUIRED', reason: 'OWNER' }, 'an owner somewhere is an owner');
  assert.deepEqual(await mfa.accountMfaRequirement(db([], true), 'a'), { requirement: 'ENABLED', reason: 'OPT_IN' });
  assert.deepEqual(await mfa.accountMfaRequirement(db([], false), 'a'), { requirement: 'NONE', reason: null });
});

test('the feature is off unless explicitly switched on', () => {
  delete process.env.DINODIA_MFA_ENFORCED;
  assert.equal(mfa.mfaEnforced(), false);
  process.env.DINODIA_MFA_ENFORCED = 'true';
  assert.equal(mfa.mfaEnforced(), true);
  process.env.DINODIA_MFA_ENFORCED = '1';
  assert.equal(mfa.mfaEnforced(), false, 'only the exact word "true" counts');
  delete process.env.DINODIA_MFA_ENFORCED;
});

test('the email shown on screen is masked and a challenge is tied to the exact phone, session or Alexa request', () => {
  assert.equal(mfa.maskEmail('nivedit@gmail.com'), 'n***@gmail.com');
  assert.equal(mfa.maskEmail('a@b.co'), 'a*@b.co');
  assert.equal(mfa.maskEmail('nonsense'), 'your email');
  assert.notEqual(mfa.deviceBinding('phone-1', 'thumb'), mfa.deviceBinding('phone-2', 'thumb'));
  assert.notEqual(mfa.deviceBinding('phone-1', 'thumb'), mfa.deviceBinding('phone-1', 'other'));
  assert.notEqual(mfa.sessionBinding('s'), mfa.alexaBinding('s'), 'a code for one kind of step cannot be used for another');
});

test('failures are worded for the person and carry the number of tries left', () => {
  assert.equal(mfa.mfaFailureError({ ok: false, reason: 'INVALID_CODE', attemptsRemaining: 4 }).message, 'That code isn’t right. You have 4 tries left.');
  assert.equal(mfa.mfaFailureError({ ok: false, reason: 'INVALID_CODE', attemptsRemaining: 1 }).message, 'That code isn’t right. You have 1 try left.');
  const locked = mfa.mfaFailureError({ ok: false, reason: 'LOCKED' });
  assert.equal(locked.status, 429);
  assert.equal(locked.code, 'MFA_LOCKED');
  assert.equal(mfa.mfaFailureError({ ok: false, reason: 'EXPIRED' }).code, 'MFA_CODE_EXPIRED');
  assert.equal(mfa.mfaFailureError({ ok: false, reason: 'INVALID' }).code, 'MFA_CHALLENGE_INVALID');
});

test('the reminder shows for tenants who have not turned it on, goes quiet for a week, and stops after three "not now"', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const none = { requirement: 'NONE', reason: null };
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: null, mfaPromptDismissCount: 0 }, none, now), true);
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: new Date('2026-11-05T12:00:00Z'), mfaPromptDismissCount: 1 }, none, now), false, 'snoozed');
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: new Date('2026-10-30T12:00:00Z'), mfaPromptDismissCount: 1 }, none, now), true, 'snooze over');
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: null, mfaPromptDismissCount: 3 }, none, now), false, 'three dismissals end the card');
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: null, mfaPromptDismissCount: 0 }, { requirement: 'ENABLED', reason: 'OPT_IN' }, now), false);
  assert.equal(mfa.mfaPromptState({ mfaPromptSnoozedUntil: null, mfaPromptDismissCount: 0 }, { requirement: 'REQUIRED', reason: 'OWNER' }, now), false);
});
