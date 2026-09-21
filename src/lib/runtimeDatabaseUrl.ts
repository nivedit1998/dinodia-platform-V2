export function runtimeDatabaseUrl(raw = process.env.DATABASE_URL): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // Prisma prepared statements must be disabled for Supabase's transaction
    // pooler. Keep direct/session migration URLs untouched.
    if (/\.pooler\.supabase\.com$/i.test(url.hostname) && url.port === '6543') {
      url.searchParams.set('pgbouncer', 'true');
    }
    return url.toString();
  } catch {
    return raw;
  }
}
