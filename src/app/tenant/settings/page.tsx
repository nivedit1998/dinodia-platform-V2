// Architecture: App Router surface src/app/tenant/settings/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Role } from '@prisma/client';
import TenantSettings from '../ui/TenantSettings';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';

export default async function TenantSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  const status = await getUserPolicyStatus(user.id);
  if (!status.privacyAccepted || !status.termsAccepted) {
    redirect('/tenant/policy');
  }

  return <TenantSettings username={user.username} />;
}
