// Architecture: Reusable web UI component src/components/trigger-device/TriggerDeviceTile.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { TriggerDeviceSummary } from '@/types/triggerDevice';

type TriggerDeviceTileProps = {
  remote: TriggerDeviceSummary;
  onOpenDetails: () => void;
};

export function TriggerDeviceTile({ remote, onOpenDetails }: TriggerDeviceTileProps) {
  const targetName = remote.target?.name?.trim() || 'No target assigned';
  const areaSubtitle =
    remote.displayAreaName && remote.parentAreaName && remote.displayAreaName !== remote.parentAreaName
      ? remote.displayAreaName
      : null;
  const stateText =
    remote.binding?.enabled === false
      ? 'Disabled'
      : remote.binding
        ? remote.resolutionState === 'target_unavailable'
          ? 'Linked • target unavailable'
          : remote.resolutionState === 'target_unresolved'
          ? 'Bound • target unresolved'
          : 'Linked'
        : 'Unlinked';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetails();
        }
      }}
      className="relative w-full max-w-[360px] select-none rounded-[22px] border border-purple-200/70 bg-purple-100/70 p-4 shadow-[0_14px_30px_rgba(88,28,135,0.12)] backdrop-blur transition duration-300 hover:-translate-y-0.5 active:translate-y-0 sm:max-w-none"
    >
      <div className="flex min-h-[72px] items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-slate-950">{remote.displayName ?? remote.name}</p>
          {areaSubtitle ? (
            <p className="mt-1 truncate text-xs font-medium text-slate-500">{areaSubtitle}</p>
          ) : null}
          <p className="mt-1 truncate text-sm text-purple-950/75">
            {targetName === 'No target assigned' ? 'Unlinked' : `Controls ${targetName}`}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/75 px-3 py-1 text-xs font-semibold text-purple-900">
          {stateText}
        </span>
      </div>
    </div>
  );
}
