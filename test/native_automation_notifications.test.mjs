import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/nativeAutomations/notificationPolicy.ts'), 'utf8');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(require, loaded, loaded.exports);
const { nextAllowedAutomationNotificationAt } = loaded.exports;

const weekdayQuiet = { version: 1, enabled: true, startLocalTime: '22:00', endLocalTime: '07:00', timeZone: 'Europe/London', days: [1, 2, 3, 4, 5, 6, 7] };

test('tenant automation failure notice quiet-hours policy defers until the real local quiet end', () => {
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-09T22:30:00Z'), weekdayQuiet)?.toISOString(), '2026-10-10T06:00:00.000Z');
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-09T12:30:00Z'), weekdayQuiet)?.toISOString(), '2026-10-09T12:30:00.000Z');
});

test('overnight quiet hours follow the selected local start day and handle the UK DST boundary', () => {
  const weekdays = { ...weekdayQuiet, days: [5] };
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-09T22:30:00Z'), weekdays)?.toISOString(), '2026-10-10T06:00:00.000Z');
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-24T21:30:00Z'), { ...weekdays, days: [6], startLocalTime: '22:00', endLocalTime: '02:00' })?.toISOString(), '2026-10-25T02:00:00.000Z');
});

test('malformed enabled quiet-hours policy fails closed while disabled policy does not defer', () => {
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-09T23:00:00Z'), { ...weekdayQuiet, timeZone: 'Not/AZone' }), null);
  assert.equal(nextAllowedAutomationNotificationAt(new Date('2026-10-09T23:00:00Z'), { ...weekdayQuiet, enabled: false })?.toISOString(), '2026-10-09T23:00:00.000Z');
});
