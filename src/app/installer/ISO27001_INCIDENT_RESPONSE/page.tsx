// Architecture: App Router surface src/app/installer/ISO27001_INCIDENT_RESPONSE/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { CompanyPortalShell } from '@/components/companyPortal/CompanyPortalShell';
import { getCompanyLandingPath } from '@/lib/companyPortalAccess';
import ISO27001IncidentResponseClient from './ISO27001IncidentResponseClient';

export const dynamic = 'force-dynamic';

export default async function InstallerISO27001IncidentResponsePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/companylogin/login');
  if (user.role !== Role.CXO) redirect(getCompanyLandingPath(user.role));

  return (
    <CompanyPortalShell username={user.username} role={user.role}>
      <ISO27001IncidentResponseClient installerName={user.username} />
    </CompanyPortalShell>
  );
}
