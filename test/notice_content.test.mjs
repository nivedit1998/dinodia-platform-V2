import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/noticeContent.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, require);
const { composeNotice, noticeEmail, NOTICE_EVENT_KIND } = loaded.exports;

const home = '12 High Street, London';
const cases = {
  ROOM_ACCESS_REQUEST_NOTICE: { homeLabel: home, roomName: 'Living Room', requesterName: 'Priya Shah', requesterEmail: 'priya@example.com', at: '2026-10-31T14:05:00Z' },
  ROOM_ACCESS_APPROVED_NOTICE: { homeLabel: home, roomName: 'Living Room' },
  ROOM_ACCESS_DECLINED_NOTICE: { homeLabel: home, roomName: 'Living Room' },
  TENANT_ACCESS_REMOVAL_NOTICE: { homeLabel: home, removal: 'TENANT', at: '2026-10-31T14:05:00Z' },
  PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE: { homeLabel: home, removal: 'PROPERTY_MANAGER' },
  OWNERSHIP_TRANSFER_NOTICE: { homeLabel: home, removal: 'OWNERSHIP_TRANSFER', role: 'OWNER' },
  HOME_DEREGISTRATION_NOTICE: { homeLabel: home, removal: 'FULL_HOME_DEREGISTRATION', role: 'OWNER' },
  ALEXA_LINKED_NOTICE: { at: '2026-10-31T14:05:00Z' },
  NEW_DEVICES_NOTICE: { homeLabel: home, reference: 'DIN-ABC123', audience: 'OWNER', devices: [{ name: 'Ceiling light', room: 'Kitchen' }, { name: 'Radiator', room: 'Hall' }] },
};

test('every notice has a short banner, a clear email with detail, and a link into the app', () => {
  for (const [type, details] of Object.entries(cases)) {
    const content = composeNotice(type, details);
    assert.ok(content, type);
    assert.ok(content.pushTitle.length <= 32, `${type} title fits: ${content.pushTitle}`);
    assert.ok(content.pushBody.length <= 120, `${type} body fits a lock screen: ${content.pushBody.length}`);
    const mail = noticeEmail(content);
    assert.ok(mail.subject.length > 10 && mail.subject.length <= 100, `${type} subject`);
    assert.ok(mail.text.includes('https://dinodia-platform-v2.vercel.app/app') && mail.html.includes('href="https://dinodia-platform-v2.vercel.app/app"'));
    assert.ok(mail.html.startsWith('<!doctype html>'));
    assert.ok(!/undefined|null|\[object/i.test(mail.text + mail.html + content.pushBody), `${type} has no stray placeholders`);
  }
});

test('a room request names the person, their email, the room and the Home in the email, and the person and room in the banner', () => {
  const content = composeNotice('ROOM_ACCESS_REQUEST_NOTICE', cases.ROOM_ACCESS_REQUEST_NOTICE);
  assert.equal(content.pushBody, 'Priya Shah would like to use Living Room. Tap to review and approve.');
  const mail = noticeEmail(content);
  for (const part of ['Priya Shah', 'priya@example.com', 'Living Room', home, '31 October 2026 at 14:05 UTC']) assert.ok(mail.text.includes(part), part);
  assert.equal(mail.subject, 'Priya Shah has asked for access to Living Room');
});

test('details are escaped in the HTML email and cannot inject markup', () => {
  const mail = noticeEmail(composeNotice('ROOM_ACCESS_REQUEST_NOTICE', { ...cases.ROOM_ACCESS_REQUEST_NOTICE, requesterName: '<script>alert(1)</script>', roomName: 'A & B "room"' }));
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('&lt;script&gt;') && mail.html.includes('A &amp; B &quot;room&quot;'));
});

test('missing details fall back to friendly generic wording, never "undefined"', () => {
  for (const type of Object.keys(NOTICE_EVENT_KIND).filter((name) => name !== 'NEW_DEVICES_NOTICE')) {
    const content = composeNotice(type, {});
    assert.ok(content, type);
    assert.ok(!/undefined|null/.test(content.pushBody + content.paragraphs.join(' ')), type);
  }
  assert.equal(composeNotice('NEW_DEVICES_NOTICE', { audience: 'OWNER', devices: [] }), null, 'a device notice with nothing in it is never sent');
  assert.equal(composeNotice('SOMETHING_ELSE', {}), null);
});

test('new devices: owners hear what Dinodia installed and where; tenants hear only their rooms; long lists are capped', () => {
  const owner = composeNotice('NEW_DEVICES_NOTICE', cases.NEW_DEVICES_NOTICE);
  assert.equal(owner.pushBody, 'Dinodia added 2 new devices in Kitchen and Hall. Tap to see what’s new.');
  const ownerMail = noticeEmail(owner);
  assert.ok(ownerMail.text.includes('• Ceiling light · Kitchen') && ownerMail.text.includes('• Radiator · Hall') && ownerMail.text.includes('DIN-ABC123'));
  const tenant = composeNotice('NEW_DEVICES_NOTICE', { homeLabel: home, audience: 'TENANT', devices: [{ name: 'Lamp', room: 'Bedroom' }] });
  assert.equal(tenant.pushBody, '1 new device added in Bedroom. Tap to open Dinodia.');
  assert.ok(!noticeEmail(tenant).text.includes('request DIN-'));
  const many = composeNotice('NEW_DEVICES_NOTICE', { audience: 'OWNER', devices: Array.from({ length: 30 }, (_, i) => ({ name: `Light ${i}`, room: `Room ${i}` })) });
  assert.equal(many.list.length, 13);
  assert.equal(many.list.at(-1), 'and 18 more');
  assert.ok(many.pushBody.length <= 120);
});

test('Alexa and removal notices say what to do next', () => {
  const alexa = noticeEmail(composeNotice('ALEXA_LINKED_NOTICE', cases.ALEXA_LINKED_NOTICE));
  assert.ok(alexa.text.includes('unlink it') && alexa.text.includes('changing your password'));
  const removed = composeNotice('TENANT_ACCESS_REMOVAL_NOTICE', cases.TENANT_ACCESS_REMOVAL_NOTICE);
  assert.equal(removed.pushTitle, 'Your access has ended');
  assert.ok(noticeEmail(removed).text.includes('Your Dinodia account is still active'));
  assert.equal(composeNotice('OWNERSHIP_TRANSFER_NOTICE', { homeLabel: home, removal: 'OWNERSHIP_TRANSFER', role: 'PROPERTY_MANAGER' }).pushTitle, 'Your manager access has ended');
});
