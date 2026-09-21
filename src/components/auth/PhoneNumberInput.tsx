// Architecture: Reusable web UI component src/components/auth/PhoneNumberInput.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { PHONE_COUNTRIES } from '@/lib/phoneCountries';

type PhoneNumberInputProps = {
  countryIso2: string;
  phoneNumber: string;
  onCountryChange: (value: string) => void;
  onPhoneNumberChange: (value: string) => void;
  label?: string;
  required?: boolean;
};

export function PhoneNumberInput({
  countryIso2,
  phoneNumber,
  onCountryChange,
  onPhoneNumberChange,
  label = 'Phone number',
  required = false,
}: PhoneNumberInputProps) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      <div className="grid grid-cols-[minmax(120px,0.45fr)_1fr] gap-2">
        <select
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          value={countryIso2}
          onChange={(event) => onCountryChange(event.target.value)}
          aria-label="Country code"
          required={required}
        >
          {PHONE_COUNTRIES.map((country) => (
            <option key={country.iso2} value={country.iso2}>
              {country.name} ({country.dialCode})
            </option>
          ))}
        </select>
        <input
          type="tel"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          value={phoneNumber}
          onChange={(event) => onPhoneNumberChange(event.target.value)}
          autoComplete="tel"
          placeholder="7123 456 789"
          required={required}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Spaces and brackets are fine. We’ll format it securely before saving.
      </p>
    </div>
  );
}
