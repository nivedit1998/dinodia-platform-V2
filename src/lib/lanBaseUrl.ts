// Architecture: Shared platform helper src/lib/lanBaseUrl.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isPrivateIpv4(ip: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const [a, b] = ip.split('.').map((n) => Number(n));
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function normalizeLanBaseUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }

  if (url.protocol !== 'http:') return null;
  if (!url.hostname || !isPrivateIpv4(url.hostname)) return null;
  const port = url.port ? Number(url.port) : 80;
  if (port !== 8123) return null;
  if (url.pathname && url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;

  return `http://${url.hostname}:8123`;
}
