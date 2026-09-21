// Architecture: Reusable web UI component src/components/trigger-device/TriggerDeviceDetailSheet.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useEffect, useMemo, useState } from 'react';

import type { TriggerDeviceSummary, TriggerTargetOption } from '@/types/triggerDevice';
import { Modal } from '@/components/ui/Modal';

type TriggerDeviceDetailSheetProps = {
  remote: TriggerDeviceSummary;
  targetOptions: TriggerTargetOption[];
  onClose: () => void;
  onSaveTarget: (args: { targetDeviceId: string; targetEntityId: string }) => Promise<void>;
  canManageTenantDevice?: boolean;
  onEditDevice?: () => Promise<void>;
  onMoveDevice?: () => Promise<void>;
  onDeleteDevice?: () => Promise<void>;
};

function findTargetOptionId(
  options: TriggerTargetOption[],
  deviceId: string | null | undefined,
  entityId: string | null | undefined
) {
  const normalizedDeviceId = (deviceId ?? '').trim();
  const normalizedEntityId = (entityId ?? '').trim();
  if (!normalizedDeviceId || !normalizedEntityId) return '';
  return (
    options.find(
      (option) =>
        option.targetDeviceId === normalizedDeviceId &&
        option.targetEntityId === normalizedEntityId
    )?.optionId ?? ''
  );
}

export function TriggerDeviceDetailSheet({
  remote,
  targetOptions,
  onClose,
  onSaveTarget,
  canManageTenantDevice = false,
  onEditDevice,
  onMoveDevice,
  onDeleteDevice,
}: TriggerDeviceDetailSheetProps) {
  const [targetOptionsSnapshot, setTargetOptionsSnapshot] = useState(targetOptions);
  const [editing, setEditing] = useState(false);
  const [selectedTargetOptionId, setSelectedTargetOptionId] = useState(
    findTargetOptionId(
      targetOptions,
      remote.binding?.targetDeviceId ?? remote.target?.deviceId,
      remote.binding?.targetEntityId ?? remote.target?.entityId
    )
  );
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing || saving) return;
    setTargetOptionsSnapshot(targetOptions);
  }, [targetOptions, editing, saving]);

  useEffect(() => {
    if (saving) return;
    setEditing(false);
    setSelectedTargetOptionId(
      findTargetOptionId(
        targetOptionsSnapshot,
        remote.binding?.targetDeviceId ?? remote.target?.deviceId,
        remote.binding?.targetEntityId ?? remote.target?.entityId
      )
    );
    setError(null);
  }, [
    remote.triggerDeviceId,
    remote.binding?.targetDeviceId,
    remote.binding?.targetEntityId,
    remote.target?.deviceId,
    remote.target?.entityId,
    targetOptionsSnapshot,
    saving,
  ]);

  const sortedTargets = useMemo(() => {
    return [...targetOptionsSnapshot].sort((left, right) => {
      const leftArea = (left.areaName ?? '').trim();
      const rightArea = (right.areaName ?? '').trim();
      if (leftArea !== rightArea) return leftArea.localeCompare(rightArea);
      if (left.label !== right.label) return left.label.localeCompare(right.label);
      return left.deviceName.localeCompare(right.deviceName);
    });
  }, [targetOptionsSnapshot]);

  const currentTarget =
    remote.target?.name ??
    remote.binding?.bindingName ??
    remote.binding?.targetEntityId ??
    remote.binding?.targetDeviceId ??
    'No target assigned';

  return (
    <Modal
      open
      title={remote.displayName ?? remote.name}
      description={`Controls • ${currentTarget}`}
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="mt-1 text-sm text-foreground/80">Target: {currentTarget}</p>
            <p className="mt-1 text-sm text-foreground/80">
              Status:{' '}
              {remote.resolutionState === 'bound'
                ? 'Linked'
                : remote.resolutionState === 'target_unavailable'
                  ? 'Target unavailable'
                : remote.resolutionState === 'target_unresolved'
                  ? 'Linked, target unresolved'
                  : remote.resolutionState === 'unbound'
                    ? 'Unlinked'
                    : 'Unknown'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Change what device this trigger controls"
            onClick={() => setEditing((prev) => !prev)}
            className="rounded-full border border-border bg-surface px-3 py-2 text-lg text-muted shadow-sm"
          >
            ⋯
          </button>
        </div>

        {editing ? (
          <div className="space-y-4 rounded-2xl border border-border bg-surface-2 p-4">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">Change what device this trigger controls</p>
              <p className="text-sm text-muted">
                Choose the device this trigger should control. Changes save immediately. The target must already be supported by
                Dinodia Remote Manager.
              </p>
            </div>
            <label className="block text-sm font-medium text-foreground">
              Target device
              <select
                className="mt-2 w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-foreground outline-none"
                value={selectedTargetOptionId}
                disabled={saving}
                onChange={async (event) => {
                  const nextValue = event.target.value;
                  setSelectedTargetOptionId(nextValue);
                  if (!nextValue) return;
                  const selectedTarget = sortedTargets.find((target) => target.optionId === nextValue);
                  if (!selectedTarget) return;
                  setSaving(true);
                  setError(null);
                  try {
                    await onSaveTarget({
                      targetDeviceId: selectedTarget.targetDeviceId,
                      targetEntityId: selectedTarget.targetEntityId,
                    });
                    setEditing(false);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'We couldn’t update this trigger right now.');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <option value="">Select a target</option>
                {sortedTargets.map((target) => {
                  const area = (target.areaName ?? '').trim();
                  const prefix = area ? `${area} • ` : '';
                  return (
                    <option key={target.optionId} value={target.optionId}>
                      {prefix}
                      {target.deviceName} ({target.label})
                    </option>
                  );
                })}
              </select>
            </label>
            {error ? (
              <p className="rounded-2xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setSelectedTargetOptionId(
                    findTargetOptionId(
                      targetOptionsSnapshot,
                      remote.binding?.targetDeviceId ?? remote.target?.deviceId,
                      remote.binding?.targetEntityId ?? remote.target?.entityId
                    )
                  );
                }}
                className="rounded-2xl border border-border px-4 py-2 text-sm text-muted disabled:opacity-50"
              >
                Cancel
              </button>
              {saving ? <span className="text-sm text-muted">Saving target…</span> : null}
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-border bg-surface-2 p-4">
          <p className="text-xs uppercase tracking-[0.28em] text-muted">Status</p>
          <p className="mt-2 text-sm text-foreground">
            {remote.binding?.enabled === false
              ? 'Binding disabled'
              : remote.target
                ? `Controls ${remote.target.name}`
                : remote.binding
                  ? `Controls ${currentTarget}`
                  : 'No binding configured'}
          </p>
          <p className="mt-1 text-sm text-muted">
            {remote.target?.domain ? `Target domain: ${remote.target.domain}` : 'Target domain unknown'}
          </p>
        </div>

        {canManageTenantDevice ? (
          <div className="rounded-2xl border border-border bg-surface-2 p-4">
            <p className="text-xs uppercase tracking-[0.28em] text-muted">Manage Device</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={saving || managing || !onEditDevice}
                onClick={async () => {
                  if (!onEditDevice) return;
                  setManaging(true);
                  setError(null);
                  try {
                    await onEditDevice();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'We couldn’t update this device right now.');
                  } finally {
                    setManaging(false);
                  }
                }}
                className="rounded-2xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
              >
                Edit device
              </button>
              <button
                type="button"
                disabled={saving || managing || !onMoveDevice}
                onClick={async () => {
                  if (!onMoveDevice) return;
                  setManaging(true);
                  setError(null);
                  try {
                    await onMoveDevice();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'We couldn’t move this device right now.');
                  } finally {
                    setManaging(false);
                  }
                }}
                className="rounded-2xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
              >
                Move device
              </button>
              <button
                type="button"
                disabled={saving || managing || !onDeleteDevice}
                onClick={async () => {
                  if (!onDeleteDevice) return;
                  const confirmed = window.confirm(
                    `Delete ${remote.displayName ?? remote.name}? If it is still paired to the Zigbee network, it may reappear later.`
                  );
                  if (!confirmed) return;
                  setManaging(true);
                  setError(null);
                  try {
                    await onDeleteDevice();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'We couldn’t delete this device right now.');
                  } finally {
                    setManaging(false);
                  }
                }}
                className="rounded-2xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
              >
                Delete device
              </button>
              {managing ? <span className="self-center text-sm text-muted">Saving…</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
