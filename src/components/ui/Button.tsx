// Architecture: Reusable web UI component src/components/ui/Button.tsx; renders part of the platform surface and receives state/actions from its parent flow.
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const variantClass: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--indigo)] text-white hover:brightness-110 shadow-sm disabled:brightness-100',
  secondary:
    'border border-border bg-surface text-foreground hover:bg-surface-2 shadow-sm',
  quiet: 'bg-transparent text-foreground hover:bg-surface-2',
  danger:
    'bg-[var(--danger)] text-white hover:brightness-110 shadow-sm disabled:brightness-100',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-sm',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    children,
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    disabled,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-[14px] font-semibold transition',
        'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] focus:ring-offset-1 focus:ring-offset-transparent',
        sizeClass[size],
        variantClass[variant],
        fullWidth ? 'w-full' : '',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className ?? '',
      ].join(' ')}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden
        />
      ) : null}
      <span>{children}</span>
    </button>
  );
});
