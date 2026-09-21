// Architecture: Shared platform helper src/lib/appStoreUrl.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

export function getIosAppStoreUrlConfig(): {
  appStoreUrl: string | null;
  configError: string | null;
} {
  const raw = process.env.APP_STORE_URL?.trim() ?? '';
  if (!raw) {
    return {
      appStoreUrl: null,
      configError: 'APP_STORE_URL is not configured.',
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'apps.apple.com') {
      return {
        appStoreUrl: null,
        configError: 'APP_STORE_URL must be a valid https://apps.apple.com/... URL.',
      };
    }
    return { appStoreUrl: parsed.toString(), configError: null };
  } catch {
    return {
      appStoreUrl: null,
      configError: 'APP_STORE_URL is not a valid URL.',
    };
  }
}
