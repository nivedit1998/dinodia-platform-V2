import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/avatarCatalogue.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, (name) => name === './stage1Crypto' ? { sha256 } : require(name));
const { AVATAR_ICON_KEYS, AVATAR_COLOUR_KEYS, isAvatarIconKey, isAvatarColourKey, defaultAvatarColour, publicAvatar, sharedMemberKey } = isolated.exports;

test('the catalogue is exactly the owner-approved 32 icons and 10 colours, all stable lowercase keys', () => {
  assert.equal(AVATAR_ICON_KEYS.length, 32);
  assert.equal(new Set(AVATAR_ICON_KEYS).size, 32);
  assert.equal(AVATAR_COLOUR_KEYS.length, 10);
  for (const key of [...AVATAR_ICON_KEYS, ...AVATAR_COLOUR_KEYS]) assert.match(key, /^[a-z]{2,24}$/);
});

test('only allow-listed keys validate; free text, images, hex colours and non-strings never do', () => {
  assert.equal(isAvatarIconKey('tortoise'), true);
  assert.equal(isAvatarColourKey('mint'), true);
  for (const bad of ['', 'Tortoise', 'skull', '<b>x</b>', '#ff0000', 'data:image/png;base64,AAA', null, undefined, 7, {}]) {
    assert.equal(isAvatarIconKey(bad), false);
    assert.equal(isAvatarColourKey(bad), false);
  }
});

test('an account that never chose a colour gets the same valid default every time', () => {
  const id = '3c2f3b1e-0000-4000-8000-000000000001';
  const first = defaultAvatarColour(id);
  assert.equal(defaultAvatarColour(id), first);
  assert.ok(AVATAR_COLOUR_KEYS.includes(first));
  const spread = new Set(Array.from({ length: 200 }, (_, index) => defaultAvatarColour(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)));
  assert.ok(spread.size >= 8, 'defaults spread across the palette');
});

test('publicAvatar falls back safely for unknown stored values and exposes only icon and colour', () => {
  const id = '3c2f3b1e-0000-4000-8000-000000000002';
  assert.deepEqual(publicAvatar({ id, avatarIcon: null, avatarColour: 'coral' }), { icon: null, colour: 'coral' });
  assert.deepEqual(publicAvatar({ id, avatarIcon: 'cat', avatarColour: 'sky' }), { icon: 'cat', colour: 'sky' });
  const fallback = publicAvatar({ id, avatarIcon: 'not-an-icon', avatarColour: 'not-a-colour' });
  assert.equal(fallback.icon, null);
  assert.equal(fallback.colour, defaultAvatarColour(id));
  assert.deepEqual(Object.keys(fallback).sort(), ['colour', 'icon']);
});

test('the shared-member key is stable per viewer, different across viewers and reveals no id', () => {
  const viewerA = '11111111-1111-4111-8111-111111111111';
  const viewerB = '22222222-2222-4222-8222-222222222222';
  const target = '33333333-3333-4333-8333-333333333333';
  const keyA = sharedMemberKey(viewerA, target);
  assert.equal(keyA, sharedMemberKey(viewerA, target));
  assert.notEqual(keyA, sharedMemberKey(viewerB, target));
  assert.match(keyA, /^[0-9a-f]{32}$/);
  assert.ok(!keyA.includes(target.replace(/-/g, '').slice(0, 12)));
});
