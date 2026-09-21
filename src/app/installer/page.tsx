// Architecture: App Router surface src/app/installer/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { getCompanyLandingPath, isCompanyPortalRole } from '@/lib/companyPortalAccess';

export default async function InstallerIndexPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/companylogin/login');
  }
  if (isCompanyPortalRole(user.role)) {
    redirect(getCompanyLandingPath(user.role));
  }
  if (user.role === Role.ADMIN || user.role === Role.TENANT) {
    redirect('/login');
  }
  redirect('/companylogin/login');
}
