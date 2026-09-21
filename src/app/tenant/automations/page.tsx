// Architecture: App Router surface src/app/tenant/automations/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import TenantAutomations from '@/app/tenant/ui/TenantAutomations';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';

export default async function TenantAutomationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  const status = await getUserPolicyStatus(user.id);
  if (!status.privacyAccepted || !status.termsAccepted) {
    redirect('/tenant/policy');
  }

  return <TenantAutomations />;
}
