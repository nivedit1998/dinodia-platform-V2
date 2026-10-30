import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/customerUsername.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, require);
const { usernameBase, generateAvailableUsername, CUSTOMER_USERNAME_PATTERN } = isolated.exports;

test('a username base is a readable lowercase name', () => {
  assert.equal(usernameBase('Emily Parker', 'x@example.com'), 'emily.parker');
  assert.equal(usernameBase('  José  Álvarez-Gómez ', 'x@example.com'), 'jose.alvarez.gomez');
});

test('a name with too few usable letters falls back to the email, then to a default', () => {
  assert.equal(usernameBase('李', 'sam.jones+tag@example.com'), 'sam.jones.tag');
  assert.equal(usernameBase('!', 'a@example.com'), 'dinodia.user');
});

test('the base is used when free, otherwise a numbered variant that is free', async () => {
  assert.equal(await generateAvailableUsername('Emily Parker', 'e@example.com', async () => false), 'emily.parker');
  const taken = new Set(['emily.parker']);
  const next = await generateAvailableUsername('Emily Parker', 'e@example.com', async (value) => taken.has(value));
  assert.match(next, /^emily\.parker\d{2,5}$/);
  assert.ok(CUSTOMER_USERNAME_PATTERN.test(next));
});

test('every generated username satisfies the account username rule even when nearly everything is taken', async () => {
  let calls = 0;
  const value = await generateAvailableUsername('Emily Parker', 'e@example.com', async () => { calls += 1; return true; }, 5);
  assert.equal(calls, 5);
  assert.ok(CUSTOMER_USERNAME_PATTERN.test(value), value);
});

test('long names stay within the 80 character limit', async () => {
  const value = await generateAvailableUsername('A'.repeat(200), 'e@example.com', async () => false);
  assert.ok(value.length <= 80 && CUSTOMER_USERNAME_PATTERN.test(value));
});
