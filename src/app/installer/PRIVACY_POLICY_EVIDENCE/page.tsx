// Architecture: App Router surface src/app/installer/PRIVACY_POLICY_EVIDENCE/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { CompanyPortalShell } from '@/components/companyPortal/CompanyPortalShell';
import { getCompanyLandingPath } from '@/lib/companyPortalAccess';
import { PRIVACY_NOTICE_LAST_UPDATED, PRIVACY_NOTICE_VERSION, TERMS_LAST_UPDATED, TERMS_VERSION } from '@/lib/policyVersions';
import PrivacyPolicyEvidenceClient from './PrivacyPolicyEvidenceClient';

export const dynamic = 'force-dynamic';

export default async function InstallerPrivacyPolicyEvidencePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/companylogin/login');
  if (user.role !== Role.CXO) redirect(getCompanyLandingPath(user.role));

  return (
    <CompanyPortalShell username={user.username} role={user.role}>
      <PrivacyPolicyEvidenceClient
        installerName={user.username}
        privacyVersion={PRIVACY_NOTICE_VERSION}
        privacyLastUpdated={PRIVACY_NOTICE_LAST_UPDATED}
        termsVersion={TERMS_VERSION}
        termsLastUpdated={TERMS_LAST_UPDATED}
      />
    </CompanyPortalShell>
  );
}
