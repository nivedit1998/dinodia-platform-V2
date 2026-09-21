// Architecture: Shared platform helper src/lib/theme.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'dinodia.theme';

export function getStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export function setStoredTheme(theme: ThemePreference) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function applyThemeToDocument(theme: ThemePreference) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  }
}

export function getEffectiveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const themeBootstrapScript = `(() => {
  try {
    const key = '${STORAGE_KEY}';
    const theme = localStorage.getItem(key);
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch {}
})();`;
