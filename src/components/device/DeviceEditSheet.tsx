// Architecture: Reusable web UI component src/components/device/DeviceEditSheet.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { useEffect, useState } from 'react';
import { UIDevice } from '@/types/device';
import { getPrimaryLabel } from '@/lib/deviceLabels';

type DeviceEditSheetProps = {
  device: UIDevice;
  values: {
    name: string;
    area: string;
    label: string;
    blindTravelSeconds?: string;
  };
  onChange: (key: keyof DeviceEditSheetProps['values'], value: string) => void;
  onSave: () => void;
  onClose: () => void;
  saving?: boolean;
};

export function DeviceEditSheet({
  device,
  values,
  onChange,
  onSave,
  onClose,
  saving = false,
}: DeviceEditSheetProps) {
  const [visible, setVisible] = useState(false);
  const primaryLabel = getPrimaryLabel(device);
  const isBlind = primaryLabel === 'Blind';

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center px-4 py-6 transition ${
        visible ? 'bg-slate-900/45' : 'bg-slate-900/0'
      }`}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-md rounded-3xl border border-white/30 bg-white/90 p-6 shadow-2xl backdrop-blur-2xl transition-all duration-300 ${
          visible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
              Edit
            </p>
            <h3 className="text-2xl font-semibold text-slate-900">
              {device.name}
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close editor"
            onClick={onClose}
            className="rounded-full bg-white/80 p-2 text-slate-500 shadow"
          >
            ×
          </button>
        </div>
        <div className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-slate-600">
            Display name
            <input
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-base text-slate-900 outline-none transition focus:border-indigo-400"
              value={values.name}
              onChange={(event) => onChange('name', event.target.value)}
            />
          </label>
          {isBlind && (
            <label className="block text-sm font-semibold text-slate-600">
              Blind travel time (seconds)
              <input
                type="number"
                min={1}
                max={300}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-base text-slate-900 outline-none transition focus:border-indigo-400"
                value={values.blindTravelSeconds ?? ''}
                placeholder="Defaults to 22 seconds if empty"
                onChange={(event) => onChange('blindTravelSeconds', event.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Controls how long Dinodia moves this blind via script.global_blind_controller. Leave
                blank to use the default (22s).
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => onChange('blindTravelSeconds', '15')}
                >
                  15s
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => onChange('blindTravelSeconds', '22')}
                >
                  22s (default)
                </button>
                <button
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => onChange('blindTravelSeconds', '30')}
                >
                  30s
                </button>
              </div>
            </label>
          )}
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-slate-200 px-5 py-2 text-sm text-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-2xl bg-indigo-600 px-6 py-2 text-sm font-semibold text-white shadow disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
