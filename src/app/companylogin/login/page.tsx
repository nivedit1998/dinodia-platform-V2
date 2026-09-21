// Architecture: App Router surface src/app/companylogin/login/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { getCurrentUser } from '@/lib/auth';
import { getCompanyLandingPath, isCompanyPortalRole } from '@/lib/companyPortalAccess';
import CompanyLoginClient from './CompanyLoginClient';
import { redirect } from 'next/navigation';
import type { Route } from 'next';

export const dynamic = 'force-dynamic';

export default async function CompanyLoginPage() {
  const user = await getCurrentUser();
  if (user && isCompanyPortalRole(user.role)) {
    redirect(getCompanyLandingPath(user.role) as Route);
  }

  return <CompanyLoginClient />;
}
