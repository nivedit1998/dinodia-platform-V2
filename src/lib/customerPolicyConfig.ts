import { createHash } from 'node:crypto';

export type CurrentCustomerPolicy = { version: string; title: string; text: string; contentSha256: string };

/** One server-owned policy tuple shared by auth guards, claim decisions and
 * the visible customer requirements receipt. Missing or inconsistent public
 * policy configuration fails closed; the application never invents terms. */
export function currentCustomerPolicy(): CurrentCustomerPolicy | null {
  const version = String(process.env.DINODIA_NATIVE_POLICY_VERSION ?? '').trim();
  const title = String(process.env.DINODIA_NATIVE_POLICY_TITLE ?? '').trim();
  const text = String(process.env.DINODIA_NATIVE_POLICY_TEXT ?? '').trim();
  const configuredHash = String(process.env.DINODIA_NATIVE_POLICY_CONTENT_SHA256 ?? '').trim().toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(version) || !title || title.length > 160 || text.length < 20 || text.length > 40_000 || !/^[a-f0-9]{64}$/.test(configuredHash)) return null;
  const actualHash = createHash('sha256').update(text, 'utf8').digest('hex');
  if (actualHash !== configuredHash) return null;
  return { version, title, text, contentSha256: actualHash };
}
