// Architecture: Active Dinodia module scripts/check_security_headers.mjs; document its role here while preserving the existing runtime and cross-repository contracts.
import fs from 'node:fs';
import path from 'node:path';

const configPath = path.join(process.cwd(), 'next.config.ts');
if (!fs.existsSync(configPath)) {
  console.error(`[check:security] next.config.ts not found at ${configPath}`);
  process.exit(1);
}

const content = fs.readFileSync(configPath, 'utf8');

const required = [
  'X-Content-Type-Options',
  'Referrer-Policy',
  'X-Frame-Options',
  'Permissions-Policy',
  'Strict-Transport-Security',
];

const missing = required.filter((key) => !content.includes(key));
if (!content.includes("value: 'DENY'")) missing.push('X-Frame-Options=DENY');
const productionCsp = content.match(/Content-Security-Policy[\s\S]{0,500}/)?.[0] || '';
if (/unsafe-eval/i.test(productionCsp)) missing.push('production CSP must not contain unsafe-eval');
if (/script-src[^\n]*\*/i.test(productionCsp)) missing.push('production CSP script-src must not contain wildcard origins');
if (!/frame-ancestors\s+'none'/i.test(productionCsp)) missing.push("CSP frame-ancestors 'none'");
if (!/base-uri\s+'self'/i.test(productionCsp)) missing.push("CSP base-uri 'self'");
if (!/form-action\s+'self'/i.test(productionCsp)) missing.push("CSP form-action 'self'");

if (missing.length) {
  console.error('[check:security] FAIL: missing required security header definitions in next.config.ts');
  for (const key of missing) console.error(`- ${key}`);
  process.exit(1);
}

console.log('[check:security] OK');
