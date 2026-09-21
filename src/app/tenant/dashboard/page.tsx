// Architecture: App Router surface src/app/tenant/dashboard/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Role } from '@prisma/client';
import TenantDashboard from '../ui/TenantDashboard';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';

export default async function TenantDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  const status = await getUserPolicyStatus(user.id);
  if (!status.privacyAccepted || !status.termsAccepted) {
    redirect('/tenant/policy');
  }

  return <TenantDashboard username={user.username} />;
}
