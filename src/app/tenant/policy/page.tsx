// Architecture: App Router surface src/app/tenant/policy/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';
import TenantPolicyClient from './TenantPolicyClient';

export const dynamic = 'force-dynamic';

export default async function TenantPolicyPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  const status = await getUserPolicyStatus(user.id);
  if (status.privacyAccepted && status.termsAccepted) {
    redirect('/tenant/dashboard');
  }

  return <TenantPolicyClient username={user.username} privacyVersion={status.privacyVersion} termsVersion={status.termsVersion} />;
}
