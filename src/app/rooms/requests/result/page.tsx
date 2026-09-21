// Architecture: App Router surface src/app/rooms/requests/result/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { AuthShell } from '@/components/ui/AuthShell';
import { Card } from '@/components/ui/Card';

function messageForStatus(status: string | null | undefined) {
  const s = (status ?? '').toString().trim().toUpperCase();
  switch (s) {
    case 'APPROVED':
      return { title: 'Approved', body: 'Access has been granted. If you were new, check your email for login details.' };
    case 'REJECTED':
      return { title: 'Rejected', body: 'This request was rejected.' };
    case 'EXPIRED':
      return { title: 'Expired', body: 'This approval link has expired.' };
    case 'CONSUMED':
      return { title: 'Already used', body: 'This approval link was already used.' };
    case 'ALREADY_HANDLED':
      return { title: 'Already handled', body: 'This request was already approved or rejected.' };
    case 'HOME_UNCLAIMED':
      return { title: 'Home not claimed', body: 'This home is not claimed yet. A homeowner must set up the home first.' };
    case 'HOME_MISSING':
      return { title: 'Home unavailable', body: 'This hub is not linked to a home yet.' };
    case 'NOT_FOUND':
      return { title: 'Not found', body: 'This approval link is invalid.' };
    default:
      return { title: 'Done', body: 'This request could not be processed. Please try again.' };
  }
}

export default async function RoomRequestResultPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.status;
  const status = Array.isArray(raw) ? raw[0] : raw;
  const msg = messageForStatus(status);

  return (
    <AuthShell title={msg.title} subtitle="Room access request" footer={null}>
      <Card surface="muted" className="rounded-[14px] p-3 text-sm text-foreground">
        {msg.body}
      </Card>
    </AuthShell>
  );
}
