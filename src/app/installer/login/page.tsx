// Architecture: App Router surface src/app/installer/login/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';

export default function InstallerLoginRedirectPage() {
  redirect('/companylogin/login');
}
