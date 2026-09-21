// Architecture: App Router surface src/app/login/tenant/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { LoginClient } from '@/app/login/LoginClient';

export default async function TenantLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.identifier;
  const identifier = (Array.isArray(raw) ? raw[0] : raw)?.toString() ?? '';
  return <LoginClient expectedRole="TENANT" initialIdentifier={identifier} />;
}
