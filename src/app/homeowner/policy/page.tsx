// Architecture: App Router surface src/app/homeowner/policy/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { getHomeownerPolicyStatus } from '@/lib/homeownerPolicy';
import HomeownerPolicyForm from './HomeownerPolicyForm';

export default async function HomeownerPolicyPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.role !== Role.ADMIN) {
    redirect('/');
  }

  const status = await getHomeownerPolicyStatus(user.id);
  if (!status) {
    redirect('/login');
  }

  if (!status.requiresAcceptance) {
    redirect('/admin/dashboard');
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface via-background to-surface-2 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <HomeownerPolicyForm
          initialPolicyVersion={status.policyVersion}
          initialPendingOnboardingId={status.pendingOnboardingId}
        />
      </div>
    </div>
  );
}
