// Architecture: Reusable web UI component src/components/ui/Field.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useId, useState } from 'react';
import type { InputHTMLAttributes } from 'react';

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: string;
  hint?: string;
  feedback?: string | null;
  invalid?: boolean;
  containerClassName?: string;
};

export function Field({
  label,
  hint,
  feedback,
  invalid,
  id,
  type = 'text',
  className,
  containerClassName,
  ...props
}: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const [showPassword, setShowPassword] = useState(false);
  const inputType =
    type === 'password' ? (showPassword ? 'text' : 'password') : type;
  const isInvalid = Boolean(invalid || feedback);

  return (
    <div className={containerClassName}>
      <label
        htmlFor={fieldId}
        className="mb-1.5 block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          type={inputType}
          className={[
            'w-full rounded-[14px] border bg-surface px-3 py-2.5 text-sm text-foreground shadow-sm outline-none transition',
            'placeholder:text-muted focus:ring-2 focus:ring-[var(--focus-ring)]',
            isInvalid ? 'border-[var(--danger)]' : 'border-border',
            type === 'password' ? 'pr-20' : '',
            className ?? '',
          ].join(' ')}
          aria-invalid={isInvalid}
          {...props}
        />
        {type === 'password' ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-muted hover:bg-surface-2"
            onClick={() => setShowPassword((prev) => !prev)}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        ) : null}
      </div>
      {feedback ? (
        <p className="mt-1.5 text-xs text-[var(--danger)]">{feedback}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
