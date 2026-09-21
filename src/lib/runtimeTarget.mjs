const APPROVED_PROJECT_REF = 'fppzzesvukjbsfmxmfxe';
const APPROVED_VERCEL_PROJECT_ID = 'prj_8oa8iA73XjP54Ciix9LQKZ8k1f6y';
const APPROVED_DATABASE_HOSTS = new Set([
  `db.${APPROVED_PROJECT_REF}.supabase.co`,
  'aws-0-eu-west-2.pooler.supabase.com',
]);

function projectRefFromUrl(url) {
  const direct = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i);
  if (direct) return direct[1].toLowerCase();
  if (/\.pooler\.supabase\.com$/i.test(url.hostname)) {
    const username = decodeURIComponent(url.username || '');
    const match = username.match(/^(?:postgres\.)?([a-z0-9]{20})$/i);
    return match?.[1]?.toLowerCase() || '';
  }
  return '';
}

function parseDatabaseUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!databaseName) return null;
    const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (!isLoopback && !APPROVED_DATABASE_HOSTS.has(url.hostname.toLowerCase())) return null;
    return { url, databaseName, projectRef: projectRefFromUrl(url), isLoopback };
  } catch {
    return null;
  }
}

export function runtimeTargetIsValid(env = process.env) {
  const mode = String(env.V2_ENVIRONMENT || '').trim();
  if (!['local', 'test', 'rc', 'production'].includes(mode)) return false;

  const database = parseDatabaseUrl(env.DATABASE_URL);
  const direct = parseDatabaseUrl(env.DIRECT_URL);
  if (!database || !direct || database.databaseName !== direct.databaseName) return false;

  if (mode === 'local' || mode === 'test') {
    if (database.isLoopback && direct.isLoopback) return true;
  }

  if (database.projectRef !== APPROVED_PROJECT_REF || direct.projectRef !== APPROVED_PROJECT_REF) return false;
  if (String(env.SUPABASE_PROJECT_REF || '').trim() !== APPROVED_PROJECT_REF) return false;
  if (String(env.VERCEL_PROJECT_ID || '').trim() !== APPROVED_VERCEL_PROJECT_ID) return false;
  try {
    return new URL(String(env.NEXT_PUBLIC_SUPABASE_URL || '')).hostname.toLowerCase() === `${APPROVED_PROJECT_REF}.supabase.co`;
  } catch {
    return false;
  }
}
