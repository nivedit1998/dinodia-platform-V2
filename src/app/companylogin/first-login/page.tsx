// Architecture: App Router surface src/app/companylogin/first-login/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import CompanyFirstLoginClient from './CompanyFirstLoginClient';

export const dynamic = 'force-dynamic';

export default function CompanyFirstLoginPage() {
  return <CompanyFirstLoginClient />;
}
