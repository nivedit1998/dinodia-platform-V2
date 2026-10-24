import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Called only inside the existing disposable Docker/HTTP harness. Asynchronous
// spawn keeps that harness's in-process synthetic Hub serving real requests.
export async function verifyStateEvidenceIOS({ base, hubBase, fixture, deviceId }) {
  if (process.env.STATE_EVIDENCE_IOS_LIVE !== '1') return;
  for (const origin of [base, hubBase]) assert.equal(new URL(origin).hostname, '127.0.0.1');
  const iosRoot = process.env.DINODIA_IOS_ROOT;
  const derived = process.env.ROOM_QR_IOS_DERIVED_DATA;
  const simulator = process.env.ROOM_QR_SIMULATOR_ID;
  assert.ok(iosRoot && derived && simulator && fs.existsSync(derived));
  const file = path.join(iosRoot, '.state-evidence-live-test.json');
  const log = path.join(path.dirname(derived), 'ios-state-evidence-live.log');
  const fd = fs.openSync(log, 'w', 0o600);
  try {
    fs.writeFileSync(file, JSON.stringify({ base, hubBase, hubHost: 'dinodia-harness-one.dinodiasmartliving.com',
      email: fixture.loginEmail, password: fixture.loginPassword, installationId: fixture.loginInstallationId,
      publicKey: fixture.loginPublicKey, membershipId: fixture.tenantMembershipId, deviceId }), { mode: 0o600, flag: 'wx' });
    const exit = await new Promise((resolve, reject) => {
      const child = spawn('xcodebuild', ['-project', path.join(iosRoot, 'Dinodia.xcodeproj'), '-scheme', 'Dinodia', '-configuration', 'Debug',
        '-destination', `platform=iOS Simulator,id=${simulator}`, '-derivedDataPath', derived,
        'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO',
        '-only-testing:DinodiaTests/DinodiaV1SessionShellTests/testStateEvidenceAgainstDisposablePlatformAndHub', 'test'],
      { cwd: iosRoot, stdio: ['ignore', fd, fd] });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Connected iOS test exceeded 5 minutes')); }, 300000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exit, 0, `Connected iOS test failed; inspect ${log}`);
    const output = fs.readFileSync(log, 'utf8');
    assert.match(output, /testStateEvidenceAgainstDisposablePlatformAndHub.*passed/);
    assert.doesNotMatch(output, /testStateEvidenceAgainstDisposablePlatformAndHub.*skipped/);
    console.log('[state-evidence:integration] PASS: actual iOS provider/coordinator -> authenticated Platform session -> real Hub snapshot -> genuine checked bridge value; scope exit clears values');
  } finally { fs.closeSync(fd); if (fs.existsSync(file)) fs.unlinkSync(file); }
}
