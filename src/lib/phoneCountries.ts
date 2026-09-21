// Architecture: Shared platform helper src/lib/phoneCountries.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export type PhoneCountry = {
  iso2: string;
  name: string;
  dialCode: string;
};

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso2: 'GB', name: 'United Kingdom', dialCode: '+44' },
  { iso2: 'US', name: 'United States', dialCode: '+1' },
  { iso2: 'IE', name: 'Ireland', dialCode: '+353' },
  { iso2: 'IN', name: 'India', dialCode: '+91' },
  { iso2: 'FR', name: 'France', dialCode: '+33' },
  { iso2: 'DE', name: 'Germany', dialCode: '+49' },
  { iso2: 'ES', name: 'Spain', dialCode: '+34' },
  { iso2: 'IT', name: 'Italy', dialCode: '+39' },
  { iso2: 'AE', name: 'United Arab Emirates', dialCode: '+971' },
  { iso2: 'AU', name: 'Australia', dialCode: '+61' },
];

export const DEFAULT_PHONE_COUNTRY = 'GB';

export function getPhoneCountry(iso2: string | null | undefined): PhoneCountry {
  return PHONE_COUNTRIES.find((entry) => entry.iso2 === iso2) ?? PHONE_COUNTRIES[0];
}
