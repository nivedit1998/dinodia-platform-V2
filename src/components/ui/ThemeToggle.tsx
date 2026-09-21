// Architecture: Reusable web UI component src/components/ui/ThemeToggle.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  applyThemeToDocument,
  getEffectiveTheme,
  getStoredTheme,
  setStoredTheme,
  type ThemePreference,
} from '@/lib/theme';

const options: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme());
  const effective = useMemo(() => getEffectiveTheme(theme), [theme]);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      applyThemeToDocument('system');
      setTheme((current) => (current === 'system' ? 'system' : current));
    };
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);

  const applyTheme = (next: ThemePreference) => {
    setTheme(next);
    setStoredTheme(next);
    applyThemeToDocument(next);
  };

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/90 p-1 text-xs shadow-sm backdrop-blur">
      {options.map((option) => {
        const isActive = option.value === theme;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => applyTheme(option.value)}
            className={[
              'rounded-full px-3 py-1.5 font-medium transition focus:outline-none',
              isActive
                ? 'bg-[var(--indigo)] text-white shadow-sm'
                : 'text-muted hover:bg-surface-2/80 hover:text-foreground',
            ].join(' ')}
            aria-pressed={isActive}
          >
            {option.label}
          </button>
        );
      })}
      <span className="rounded-full border border-border bg-surface-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
        {effective}
      </span>
    </div>
  );
}
