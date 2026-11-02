import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/customerInvitationEmail.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, (name) => {
  if (name === '@aws-sdk/client-sesv2') return { SESv2Client: class {}, SendEmailCommand: class {} };
  return require(name);
});
const { customerInvitationEmailContent } = loaded.exports;

test('existing-account invitation email opens the app invitation flow and says to choose and accept the Home', () => {
  const invitationId = '11111111-2222-4222-8222-333333333333';
  const mail = customerInvitationEmailContent({ invitationId, role: 'TENANT', postcode: 'SW1A 1AA',
    expiresAt: new Date('2026-11-10T12:00:00Z'), temporaryPassword: null, inviterName: 'Nivedit Gupta' });
  assert.equal(mail.subject, 'Nivedit Gupta invited you to Dinodia Smart Living');
  assert.ok(mail.text.includes(`https://dinodia-platform-v2.vercel.app/app/auth#invitation=${invitationId}`));
  assert.ok(mail.html.includes('>Choose this Home</a>'));
  assert.ok(mail.text.includes('sign in with your current Dinodia account') && mail.text.includes('choose this Home from your invitations and accept'));
  assert.ok(mail.text.includes('does not grant Home access'));
  assert.ok(mail.html.includes('Nothing is shared until you accept'));
});

test('new-account invitation email escapes inviter and temporary-password content in HTML', () => {
  const mail = customerInvitationEmailContent({ invitationId: '11111111-2222-4222-8222-333333333333',
    role: 'TENANT', postcode: 'SW1A <AA>', expiresAt: new Date('2026-11-10T12:00:00Z'),
    temporaryPassword: 'safe&<script>credential', inviterName: 'Nivedit <Home>' });
  assert.ok(mail.text.includes('One-time temporary password: safe&<script>credential'));
  assert.ok(mail.html.includes('Nivedit &lt;Home&gt;'));
  assert.ok(mail.html.includes('SW1A &lt;AA&gt;'));
  assert.ok(mail.html.includes('safe&amp;&lt;script&gt;credential'));
  assert.ok(!mail.html.includes('<script>credential'));
  assert.ok(mail.html.includes('choose a new password and username'));
});
