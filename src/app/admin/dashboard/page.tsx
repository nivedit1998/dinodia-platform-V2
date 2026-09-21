// Architecture: App Router surface src/app/admin/dashboard/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Role } from '@prisma/client';
import AdminDashboard from '../ui/AdminDashboard';

export default async function AdminDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.ADMIN) redirect('/tenant/dashboard');

  return <AdminDashboard username={user.username} />;
}
