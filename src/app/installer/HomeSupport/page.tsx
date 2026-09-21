// Architecture: App Router surface src/app/installer/HomeSupport/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { CompanyPortalShell } from '@/components/companyPortal/CompanyPortalShell';
import { canAccessHomeSupport, getCompanyLandingPath } from '@/lib/companyPortalAccess';
import HomeSupportClient from './HomeSupportClient';

export const dynamic = 'force-dynamic';

export default async function InstallerHomeSupportPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/companylogin/login');
  if (!canAccessHomeSupport(user.role)) redirect(getCompanyLandingPath(user.role));

  return (
    <CompanyPortalShell username={user.username} role={user.role}>
      <HomeSupportClient installerName={user.username} role={user.role} />
    </CompanyPortalShell>
  );
}
