// Architecture: Shared platform helper src/lib/phoneNumber.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { getPhoneCountry } from '@/lib/phoneCountries';

export function normalizePhoneNumberE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Allow user-friendly formatting characters, but require a strict E.164 output.
  const cleaned = trimmed.replace(/[\s()-]/g, '');
  if (!cleaned.startsWith('+')) return null;

  const digits = cleaned.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits[0] === '0') return null;

  return `+${digits}`;
}

export function normalizePhoneNumberWithCountry(input: {
  countryIso2?: unknown;
  nationalNumber?: unknown;
  fullNumber?: unknown;
}): string | null {
  const fullNumber = typeof input.fullNumber === 'string' ? input.fullNumber.trim() : '';
  if (fullNumber.startsWith('+')) return normalizePhoneNumberE164(fullNumber);

  const national = typeof input.nationalNumber === 'string' ? input.nationalNumber.trim() : '';
  if (!national) return null;

  const country = getPhoneCountry(typeof input.countryIso2 === 'string' ? input.countryIso2 : undefined);
  const digits = national.replace(/\D/g, '');
  if (!digits) return null;

  const withoutLeadingZero = digits.replace(/^0+/, '');
  return normalizePhoneNumberE164(`${country.dialCode}${withoutLeadingZero}`);
}
