// Architecture: App Router surface src/app/installer/provision/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { CompanyPortalShell } from '@/components/companyPortal/CompanyPortalShell';
import { canAccessProvision, getCompanyLandingPath } from '@/lib/companyPortalAccess';
import ProvisionClient from './provisionClient';

export const dynamic = 'force-dynamic';

export default async function InstallerProvisionPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/companylogin/login');
  if (!canAccessProvision(user.role)) redirect(getCompanyLandingPath(user.role));

  return (
    <CompanyPortalShell username={user.username} role={user.role}>
      <ProvisionClient installerName={user.username} role={user.role} />
    </CompanyPortalShell>
  );
}
