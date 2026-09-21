// Architecture: Reusable web UI component src/components/device/DeviceTile.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useMemo } from 'react';
import { UIDevice } from '@/types/device';
import { getPrimaryLabel } from '@/lib/deviceLabels';
import {
  DeviceActionSpec,
  DeviceCommandId,
  getActionsForDevice,
  getBlindPosition,
  getBrightnessPercent,
  getTargetTemperature,
  getVolumePercent,
} from '@/lib/deviceCapabilities';
import {
  getDeviceArea,
  getDeviceSecondaryText,
  getVisualPreset,
  isDeviceActive,
  tileSizeClasses,
} from './deviceVisuals';
import { useDeviceCommand } from './DeviceControls';

const MAX_TILE_CONTROLS = 3;

type DeviceTileProps = {
  device: UIDevice;
  batteryPercent?: number | null;
  onOpenDetails: () => void;
  onActionComplete?: () => void;
  onOpenAdminEdit?: () => void;
  showAdminControls?: boolean;
  showControlButton?: boolean;
  allowDeviceControl?: boolean;
  kwhTotal?: number | null;
};

export function DeviceTile({
  device,
  batteryPercent = null,
  onOpenDetails,
  onActionComplete,
  onOpenAdminEdit,
  showAdminControls = false,
  showControlButton = true,
  allowDeviceControl = true,
  kwhTotal = null,
}: DeviceTileProps) {
  const label = getPrimaryLabel(device);
  const actions = useMemo(() => getActionsForDevice(device, 'dashboard'), [device]);
  const visual = getVisualPreset(label);
  const isActive = isDeviceActive(label, device);
  const secondary = getDeviceSecondaryText(label, device);
  const area = getDeviceArea(device);
  const { pendingCommand, sendCommand } = useDeviceCommand(
    onActionComplete,
    allowDeviceControl
  );
  const primaryAction = getPrimaryAction(label, device, actions);
  const tileControls = getTileControlSpecs(label, device, actions);
  const batteryPct = batteryPercent != null && Number.isFinite(batteryPercent) ? Math.max(0, Math.min(100, Math.round(batteryPercent))) : null;
  const batteryBarClass =
    batteryPct == null
      ? null
      : batteryPct < 25
        ? 'bg-red-500'
        : batteryPct < 50
          ? 'bg-amber-500'
          : 'bg-emerald-500';
  const stateChipLabel =
    device.state && device.state.trim()
      ? device.state.replace(/_/g, ' ')
      : isActive
        ? 'on'
        : 'off';

  const baseClasses =
    'relative w-full max-w-[360px] sm:max-w-none rounded-[26px] p-4 sm:p-6 shadow-[0_18px_40px_rgba(16,22,42,0.16)] transition duration-300 cursor-pointer select-none hover:-translate-y-0.5 active:translate-y-0';
  const bgClass = isActive ? visual.activeBg : visual.inactiveBg;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenDetails}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          onOpenDetails();
        }
      }}
      className={`${baseClasses} ${bgClass} ${tileSizeClasses(visual.size)} ${
        isActive ? 'ring-1 ring-white/40' : 'ring-1 ring-white/60'
      }`}
    >
      {batteryPct != null && batteryBarClass && (
        <div
          className={`pointer-events-none absolute top-4 flex items-center ${
            showAdminControls ? 'right-16' : 'right-4'
          }`}
          aria-hidden="true"
        >
          <div className="h-2 w-14 rounded-full bg-slate-100/80 shadow-sm ring-1 ring-white/50">
            <div
              className={`h-2 rounded-full ${batteryBarClass}`}
              style={{ width: `${batteryPct}%` }}
            />
          </div>
        </div>
      )}
      {showAdminControls && (
        <button
          type="button"
          aria-label="Edit device"
          onClick={(event) => {
            event.stopPropagation();
            onOpenAdminEdit?.();
          }}
          className="absolute right-4 top-4 rounded-full bg-white/70 px-3 py-1 text-lg text-slate-500 shadow"
        >
          ⋯
        </button>
      )}
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="space-y-2 pr-5">
          <p className="text-[11px] uppercase tracking-[0.35em] text-slate-500">
            {label}
          </p>
          <p className="text-lg font-semibold text-slate-900">{device.displayName ?? device.name}</p>
          <p className="text-sm text-slate-500">{secondary}</p>
          <p
            className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              isActive
                ? 'bg-[color:var(--indigo)]/15 text-[color:var(--indigo)]'
                : 'bg-slate-100 text-slate-600'
            }`}
          >
            {stateChipLabel}
          </p>
          {kwhTotal !== null && Number.isFinite(kwhTotal) && (
            <p className="inline-flex w-fit items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
              Energy (Total): {kwhTotal.toFixed(2)} kWh
            </p>
          )}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-400">
            <p className="text-[10px]">Area</p>
            <p className="mt-1 text-sm font-medium normal-case tracking-normal text-slate-600">
              {area}
            </p>
          </div>
        </div>
        {showControlButton && allowDeviceControl && tileControls.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {tileControls.slice(0, MAX_TILE_CONTROLS).map((control) => (
              <button
                key={control.key}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (control.kind === 'more') {
                    onOpenDetails();
                    return;
                  }
                  if (control.kind === 'slider') {
                    // Slider preview is non-interactive on tile; open details for adjustments.
                    onOpenDetails();
                    return;
                  }
                  void sendCommand({
                    entityId: device.entityId,
                    command: control.command,
                    value: control.value,
                  });
                }}
                disabled={pendingCommand !== null || control.kind === 'slider'}
                className={`flex h-10 items-center justify-center rounded-2xl border border-white/40 px-2 text-[11px] font-semibold shadow-sm transition disabled:opacity-50 ${
                  isActive ? 'bg-white/70 text-slate-900' : 'bg-white/60 text-slate-700'
                }`}
              >
                {pendingCommand && control.kind === 'command' ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-500/40 border-t-transparent" />
                ) : (
                  <span className="truncate">{control.label}</span>
                )}
              </button>
            ))}
          </div>
        ) : showControlButton && primaryAction ? (
          <div className="flex justify-end">
            <button
              type="button"
              className={`relative flex h-14 w-14 items-center justify-center rounded-2xl text-2xl shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50 sm:h-16 sm:w-16 ${
                isActive ? visual.iconActiveBg : visual.iconInactiveBg
              } ${primaryAction ? 'cursor-pointer' : 'cursor-default'}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!primaryAction || !allowDeviceControl) {
                  onOpenDetails();
                  return;
                }
                void sendCommand({
                  entityId: device.entityId,
                  command: primaryAction.command,
                  value: primaryAction.value,
                });
              }}
              disabled={pendingCommand !== null || !primaryAction || !allowDeviceControl}
            >
              {pendingCommand ? (
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/50 border-t-transparent" />
              ) : (
                <visual.icon className="h-7 w-7 text-inherit" />
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type TileControlSpec =
  | { kind: 'command'; key: string; label: string; command: DeviceCommandId; value?: number }
  | { kind: 'slider'; key: string; label: string }
  | { kind: 'more'; key: string; label: string };

function getTileControlSpecs(label: string, device: UIDevice, actions: DeviceActionSpec[]): TileControlSpec[] {
  const specs: TileControlSpec[] = [];

  const primary = getPrimaryAction(label, device, actions);
  if (primary) {
    const actionLabel = primaryActionLabelForTile(device, primary.command);
    specs.push({ kind: 'command', key: `primary:${primary.command}`, label: actionLabel, command: primary.command, value: primary.value });
  }

  // Add one "level" hint (opens details rather than controlling on tile).
  const attrs = device.attributes ?? {};
  const brightnessPct = getBrightnessPercent(attrs);
  const volumePct = getVolumePercent(attrs);
  const temp = getTargetTemperature(attrs);
  const blindPos = getBlindPosition(attrs);

  const levelCandidates: Array<{ key: string; label: string }> = [];
  if (brightnessPct !== null) levelCandidates.push({ key: 'brightness', label: `Bright ${brightnessPct}%` });
  if (typeof temp === 'number') levelCandidates.push({ key: 'temperature', label: `Temp ${Math.round(temp)}°` });
  if (volumePct !== null) levelCandidates.push({ key: 'volume', label: `Vol ${volumePct}%` });
  if (blindPos !== null) levelCandidates.push({ key: 'blind', label: `Pos ${blindPos}%` });

  if (levelCandidates.length > 0) {
    specs.push({ kind: 'slider', key: `level:${levelCandidates[0].key}`, label: levelCandidates[0].label });
  }

  // If there are more controls than we can show, add a "More" affordance.
  const eligibleCount = actions.filter((a) => a.kind === 'command' || a.kind === 'slider').length;
  const remaining = Math.max(0, eligibleCount - specs.filter((s) => s.kind !== 'more').length);
  if (remaining > 0) {
    specs.push({ kind: 'more', key: 'more', label: `More +${remaining}` });
  }

  return specs.slice(0, MAX_TILE_CONTROLS);
}

function primaryActionLabelForTile(device: UIDevice, command: DeviceCommandId) {
  const isOn = device.state.toLowerCase() === 'on' || device.state.toLowerCase() === 'heat';
  if (command.endsWith('/turn_on')) return 'On';
  if (command.endsWith('/turn_off')) return 'Off';
  if (command === 'light/toggle') return isOn ? 'Off' : 'On';
  if (command === 'media/play_pause') return 'Play';
  if (command === 'blind/open') return 'Open';
  if (command === 'blind/close') return 'Close';
  return 'Run';
}

type PrimaryAction = { command: DeviceCommandId; value?: number } | null;

function getCommandActionId(actions: DeviceActionSpec[], predicate: (id: string) => boolean) {
  const match = actions.find(
    (action): action is Extract<DeviceActionSpec, { kind: 'command' }> =>
      action.kind === 'command' && predicate(action.id)
  );
  return match?.id as DeviceCommandId | undefined;
}

function getPrimaryAction(
  label: string,
  device: UIDevice,
  actions: DeviceActionSpec[]
): PrimaryAction {
  const toggle = getCommandActionId(actions, (id) => id === 'light/toggle');
  const powerOn = getCommandActionId(actions, (id) => id.endsWith('/turn_on'));
  const powerOff = getCommandActionId(actions, (id) => id.endsWith('/turn_off'));
  const blindOpen = getCommandActionId(actions, (id) => id === 'blind/open');
  const blindClose = getCommandActionId(actions, (id) => id === 'blind/close');

  if (powerOn || powerOff || toggle) {
    const isOn =
      device.state.toLowerCase() === 'on' ||
      (device.domain === 'media_player' &&
        device.state.toLowerCase() !== 'off' &&
        device.state.toLowerCase() !== 'standby');
    return { command: isOn ? powerOff ?? toggle! : powerOn ?? toggle! };
  }

  const playPause = actions.find(
    (action): action is Extract<DeviceActionSpec, { kind: 'command' }> =>
      action.kind === 'command' && action.id === 'media/play_pause'
  );
  if (playPause) {
    return { command: playPause.id as DeviceCommandId };
  }

  if (blindOpen || blindClose) {
    const normalized = device.state.toLowerCase();
    const isOpen = normalized === 'open' || normalized === 'opening' || normalized === 'on';
    return { command: isOpen ? blindClose ?? blindOpen! : blindOpen ?? blindClose! };
  }

  switch (label) {
    case 'Blind': {
      const sliderAction = actions.find(
        (action) => action.kind === 'slider' && action.id === 'blind/set_position'
      );
      const fixedAction = actions.find(
        (action) => action.kind === 'fixed-position' && action.id === 'blind/set_position'
      ) as Extract<DeviceActionSpec, { kind: 'fixed-position' }> | undefined;
      const position = getBlindPosition(device.attributes ?? {});
      const normalized = device.state.toLowerCase();
      const isOpen =
        position !== null
          ? position > 0
          : normalized === 'open' || normalized === 'opening' || normalized === 'on';
      if (sliderAction) {
        return {
          command: sliderAction.id as DeviceCommandId,
          value: isOpen ? 0 : 100,
        };
      }
      if (fixedAction) {
        const target = isOpen
          ? fixedAction.positions.find((p) => p.value === 0)
          : fixedAction.positions.find((p) => p.value === 100);
        if (target) {
          return { command: fixedAction.id as DeviceCommandId, value: target.value };
        }
      }
      break;
    }
    default:
      break;
  }
  return null;
}
