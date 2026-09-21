// Architecture: App Router surface src/app/admin/manage-users/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Role } from '@prisma/client';
import AdminSettings from '../ui/AdminSettings';

export default async function ManageUsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.ADMIN) redirect('/tenant/dashboard');

  return <AdminSettings username={user.username} mode="users" />;
}
