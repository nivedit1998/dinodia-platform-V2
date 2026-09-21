// Architecture: App Router surface src/app/tenant/ui/TenantAccessRosterDialog.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { useEffect, type ReactNode } from 'react';

type SupportMeta = {
  kind: 'HOME_ACCESS' | 'USER_REMOTE_ACCESS';
  requestId: string;
  approvedAt: string;
  validUntil: string;
  viaUser?: { id: number; username: string; role: 'ADMIN' | 'TENANT' } | null;
};

type AccessUser = {
  id: number;
  username: string;
  role: 'ADMIN' | 'TENANT' | 'INSTALLER';
  roleLabel: 'Homeowner' | 'Tenant' | 'Support Agent';
  email: string | null;
  emailMasked: boolean;
  areas: string[];
  support?: SupportMeta | null;
};

type AccessRoster = {
  ok: true;
  tenantAreas: string[];
  counts: { uniqueUsers: number; uniqueOtherUsers: number };
  users: AccessUser[];
};

type UsersByArea = Record<string, AccessUser[]>;
type AreaShareSummary = Record<
  string,
  { otherTenants: number; supportAgents: number; homeowners: number }
>;

type Props = {
  open: boolean;
  onClose: () => void;
  roster: AccessRoster | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  groupBy: 'area' | 'user';
  setGroupBy: (value: 'area' | 'user') => void;
  usersByArea: UsersByArea;
  areaShareSummary: AreaShareSummary;
};

function formatDate(input?: string) {
  if (!input) return '';
  try {
    const d = new Date(input);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return input;
  }
}

function Pill({ children, tone }: { children: ReactNode; tone?: 'amber' | 'indigo' | 'slate' }) {
  const palette =
    tone === 'amber'
      ? 'bg-amber-100 text-amber-700'
      : tone === 'indigo'
        ? 'bg-indigo-100 text-indigo-700'
        : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${palette}`}>
      {children}
    </span>
  );
}

export default function TenantAccessRosterDialog({
  open,
  onClose,
  roster,
  loading,
  error,
  onRetry,
  groupBy,
  setGroupBy,
  usersByArea,
  areaShareSummary,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const content = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-500" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="space-y-4 py-8 text-center text-sm text-slate-700">
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-500"
          >
            Try again
          </button>
        </div>
      );
    }

    if (!roster) {
      return (
        <div className="py-10 text-center text-sm text-slate-600">
          We couldn&apos;t find access information right now.
        </div>
      );
    }

    if (groupBy === 'user') {
      return (
        <div className="space-y-3">
          {roster.users.map((user) => {
            const isSelf = user.role === 'TENANT' && !user.emailMasked;
            return (
              <div
                key={user.id}
                className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {user.username}
                    {isSelf ? ' (you)' : ''}
                  </span>
                  <Pill tone={user.role === 'INSTALLER' ? 'indigo' : user.role === 'ADMIN' ? 'slate' : undefined}>
                    {user.roleLabel}
                  </Pill>
                  {user.support?.validUntil && (
                    <Pill tone="indigo">active until {formatDate(user.support.validUntil)}</Pill>
                  )}
                </div>
                <div className="text-xs text-slate-600">
                  {user.email ? user.email : 'No email on file'}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-slate-700">
                  {user.areas.map((area) => (
                    <span
                      key={area}
                      className="rounded-full bg-white px-3 py-1 shadow-sm ring-1 ring-slate-200"
                    >
                      {area}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {roster.tenantAreas.map((area) => {
          const users = usersByArea[area] || [];
          const summary = areaShareSummary[area] || {
            otherTenants: 0,
            supportAgents: 0,
            homeowners: 0,
          };
          const pills = (
            <div className="flex flex-wrap items-center gap-2">
              {summary.otherTenants ? (
                <Pill tone="amber">
                  Shared{summary.otherTenants > 1 ? ` +${summary.otherTenants - 1}` : ''}
                </Pill>
              ) : (
                <Pill>Private</Pill>
              )}
              {summary.supportAgents ? <Pill tone="indigo">Support</Pill> : null}
            </div>
          );

          return (
            <div key={area} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">{area}</h3>
                {pills}
              </div>
              <div className="mt-3 space-y-2">
                {users.map((user) => {
                  const isSelf = user.role === 'TENANT' && !user.emailMasked;
                  return (
                    <div
                      key={`${area}-${user.id}`}
                      className="flex flex-col gap-1 rounded-xl border border-white/70 bg-white/80 px-3 py-2 shadow-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">
                          {user.username}
                          {isSelf ? ' (you)' : ''}
                        </span>
                        <Pill tone={user.role === 'INSTALLER' ? 'indigo' : user.role === 'ADMIN' ? 'slate' : undefined}>
                          {user.roleLabel}
                        </Pill>
                        {user.support?.validUntil && (
                          <Pill tone="indigo">active until {formatDate(user.support.validUntil)}</Pill>
                        )}
                      </div>
                      <div className="text-xs text-slate-600">
                        {user.email ? user.email : 'No email on file'}
                      </div>
                    </div>
                  );
                })}
                {users.length === 0 && (
                  <p className="text-xs text-slate-500">No one else can control this room.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-3 py-6 backdrop-blur-sm">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Access</h2>
            <p className="text-sm text-slate-500">Who can control which rooms</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-3">
          <div className="inline-flex rounded-full bg-slate-100 p-1 text-xs font-semibold text-slate-700">
            <button
              type="button"
              onClick={() => setGroupBy('area')}
              className={`rounded-full px-3 py-1.5 transition ${
                groupBy === 'area' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              By room
            </button>
            <button
              type="button"
              onClick={() => setGroupBy('user')}
              className={`rounded-full px-3 py-1.5 transition ${
                groupBy === 'user' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              By person
            </button>
          </div>
          {roster && (
            <div className="text-xs text-slate-500">
              {roster.counts.uniqueUsers} people total · {roster.counts.uniqueOtherUsers} others
            </div>
          )}
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 pb-6">{content()}</div>
      </div>
    </div>
  );
}
