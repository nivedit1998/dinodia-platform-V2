// Architecture: App Router surface src/app/rooms/requests/approve/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { RoomAccessApprovalKind, RoomAccessRequestStatus } from '@prisma/client';
import { AuthShell } from '@/components/ui/AuthShell';
import { Card } from '@/components/ui/Card';
import { previewRoomAccessDecisionByToken } from '@/lib/roomAccess';
import { RoomAccessDecisionClient } from '@/app/rooms/requests/RoomAccessDecisionClient';

function titleForPreview(args: { status: string; requestStatus: RoomAccessRequestStatus | null }) {
  const status = args.status.toUpperCase();
  if (status === 'ACTIONABLE') return 'Approve room access?';
  if (status === 'ALREADY_HANDLED') {
    if (args.requestStatus === RoomAccessRequestStatus.APPROVED) return 'Already approved';
    if (args.requestStatus === RoomAccessRequestStatus.REJECTED) return 'Already rejected';
    return 'Already handled';
  }
  if (status === 'CONSUMED') return 'Link already used';
  if (status === 'EXPIRED') return 'Link expired';
  if (status === 'HOME_UNCLAIMED') return 'Home not claimed';
  if (status === 'HOME_MISSING') return 'Home unavailable';
  if (status === 'NOT_FOUND') return 'Not found';
  return 'Room access request';
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export default async function RoomRequestApprovePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.toString().trim() ?? '';

  if (!token) {
    return (
      <AuthShell title="Not found" subtitle="Room access request" footer={null}>
        <Card surface="muted" className="rounded-[14px] p-3 text-sm text-foreground">
          This approval link is invalid.
        </Card>
      </AuthShell>
    );
  }

  const preview = await previewRoomAccessDecisionByToken({ tokenRaw: token, kind: RoomAccessApprovalKind.APPROVE });
  const title = titleForPreview({ status: preview.status, requestStatus: preview.requestStatus });
  const expiresAt = formatDate(preview.expiresAt);

  return (
    <AuthShell title={title} subtitle="Room access request" footer={null}>
      <Card surface="muted" className="rounded-[14px] p-4 text-sm text-foreground">
        <div className="space-y-2">
          <div>
            <div className="text-xs text-muted-foreground">Room</div>
            <div className="font-semibold">{preview.roomDisplayName ?? 'Unknown room'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Requested by</div>
            <div className="font-semibold">
              {(preview.requestedName ?? 'Unknown')} · {(preview.requestedEmail ?? 'Unknown')}
            </div>
            {preview.requestedPhoneNumber ? (
              <div className="mt-1 font-semibold">{preview.requestedPhoneNumber}</div>
            ) : null}
          </div>
          {expiresAt ? (
            <div>
              <div className="text-xs text-muted-foreground">Link expires</div>
              <div className="font-semibold">{expiresAt}</div>
            </div>
          ) : null}
        </div>

        {preview.status === 'ACTIONABLE' ? (
          <RoomAccessDecisionClient kind="approve" token={token} />
        ) : (
          <div className="mt-4 text-sm text-muted-foreground">
            No further action is needed.
          </div>
        )}
      </Card>
    </AuthShell>
  );
}
