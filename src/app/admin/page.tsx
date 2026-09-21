// Architecture: App Router surface src/app/admin/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Role } from '@prisma/client';

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.ADMIN) {
    redirect('/tenant/dashboard');
  }

  redirect('/admin/dashboard');
}
