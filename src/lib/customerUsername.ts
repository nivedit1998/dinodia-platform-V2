import { randomInt } from 'node:crypto';

export const CUSTOMER_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

/** A readable starting point such as "emily.parker" from a person's name, falling back to the email's local part. */
export function usernameBase(displayName: string, email: string): string {
  const clean = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40);
  let base = clean(displayName);
  if (base.length < 3) base = clean(email.split('@')[0] ?? '');
  if (base.length < 3) base = 'dinodia.user';
  return base;
}

/** The first username that `isTaken` does not report as used: the base, then the base with a short number. */
export async function generateAvailableUsername(
  displayName: string,
  email: string,
  isTaken: (normalized: string) => Promise<boolean>,
  attempts = 12,
): Promise<string> {
  const base = usernameBase(displayName, email);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${randomInt(10, attempt < 6 ? 1000 : 100000)}`;
    if (CUSTOMER_USERNAME_PATTERN.test(candidate) && !(await isTaken(candidate.toLowerCase()))) return candidate;
  }
  return `${base}.${randomInt(100000, 1000000)}`;
}
