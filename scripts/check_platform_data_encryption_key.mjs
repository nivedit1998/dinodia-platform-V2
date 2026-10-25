#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const EXPECTED_PROJECT_ID = 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y';
const EXPECTED_SUPABASE_REF = 'fppzzesvukjbsfmxmfxe';
const SAFE_FAILURE_CODES = new Set([
  'PLATFORM_ENCRYPTION_KEY_MISSING',
  'PLATFORM_ENCRYPTION_KEY_INVALID_ENCODING',
  'PLATFORM_ENCRYPTION_KEY_INVALID_SIZE',
]);

function fail(code) {
  process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}

function loadTypeScript(relativePath, overrides = {}) {
  const ts = require('typescript');
  const sourcePath = path.join(root, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => overrides[specifier] ?? require(specifier);
  new Function('require', 'module', 'exports', compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--env', '--project-id', '--supabase-ref'].includes(key) || !argv[i + 1] || parsed[key]) return null;
    parsed[key] = argv[++i];
  }
  return parsed['--env'] && parsed['--project-id'] && parsed['--supabase-ref'] ? parsed : null;
}

const args = parseArgs(process.argv);
if (!args) {
  process.stderr.write('Usage: node scripts/check_platform_data_encryption_key.mjs --env <private-env-file> --project-id <vercel-project-id> --supabase-ref <project-ref>\n');
  process.exit(2);
}

try {
  const envPath = path.resolve(args['--env']);
  const envStat = fs.lstatSync(envPath);
  if (!envStat.isFile() || envStat.isSymbolicLink() || (envStat.mode & 0o077) !== 0) {
    fail('ENV_FILE_NOT_PRIVATE');
  } else {
    const dotenv = require('dotenv');
    const vars = dotenv.parse(fs.readFileSync(envPath));
    if (args['--project-id'] !== EXPECTED_PROJECT_ID || args['--supabase-ref'] !== EXPECTED_SUPABASE_REF
      || vars.VERCEL_PROJECT_ID !== EXPECTED_PROJECT_ID || vars.SUPABASE_PROJECT_REF !== EXPECTED_SUPABASE_REF
      || vars.V2_ENVIRONMENT !== 'production') {
      fail('PRODUCTION_TARGET_MISMATCH');
    } else {
      const configured = vars.PLATFORM_DATA_ENCRYPTION_KEY;
      const keyModule = loadTypeScript('src/lib/platformDataEncryptionKey.ts');
      const hubModule = loadTypeScript('src/lib/hubOperatorCredentials.ts', {
        './prisma': { prisma: {} },
        './stage1Crypto': { randomSecret: () => '', sha256: () => '' },
        './platformDataEncryptionKey': keyModule,
        '@prisma/client': { Prisma: {} },
      });
      process.env.PLATFORM_DATA_ENCRYPTION_KEY = configured ?? '';
      const key = keyModule.getPlatformDataEncryptionKey();
      const probe = `dinodia-platform-encryption-readiness-${crypto.randomUUID()}`;
      const envelope = hubModule.encryptPlatformEnvelope(probe);
      const opened = hubModule.decryptPlatformEnvelope(JSON.stringify(envelope));
      const digest = keyModule.platformDataEncryptionTokenDigest(`synthetic-token-${crypto.randomUUID()}`);
      if (key.length !== 32 || key.toString('base64') !== configured || opened !== probe || !/^[a-f0-9]{64}$/.test(digest)) {
        fail('PLATFORM_ENCRYPTION_KEY_SELF_TEST_FAILED');
      } else {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          target: 'production',
          keyEncoding: 'canonical-base64',
          keySizeValid: true,
          envelopeRoundTrip: true,
          tokenDigestContract: true,
        })}\n`);
      }
    }
  }
} catch (error) {
  const code = SAFE_FAILURE_CODES.has(error?.failureCode) ? error.failureCode : 'PLATFORM_ENCRYPTION_KEY_SELF_TEST_FAILED';
  fail(code);
} finally {
  delete process.env.PLATFORM_DATA_ENCRYPTION_KEY;
}
