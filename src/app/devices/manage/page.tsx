// Architecture: App Router surface src/app/devices/manage/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import ManageDevices from './ui/ManageDevices';

export const dynamic = 'force-dynamic';

export default async function ManageDevicesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return <ManageDevices />;
}
