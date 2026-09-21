// Architecture: Shared platform helper src/lib/useDevicesVersionPolling.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import { useCallback, useEffect, useRef } from 'react';

type Options = {
  intervalMs?: number;
  jitterPct?: number;
  onVersionChange: () => void;
};

function withJitter(base: number, jitterPct: number) {
  if (jitterPct <= 0) return base;
  const delta = base * jitterPct;
  const jitter = Math.random() * delta * 2 - delta; // [-delta, +delta]
  return Math.max(1000, base + jitter);
}

export function useDevicesVersionPolling({ intervalMs = 15000, jitterPct = 0.1, onVersionChange }: Options) {
  const latestVersionRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const onVersionChangeRef = useRef(onVersionChange);

  useEffect(() => {
    onVersionChangeRef.current = onVersionChange;
  }, [onVersionChange]);

  const scheduleNext = useCallback(
    (runner: () => void, base = intervalMs) => {
      if (stoppedRef.current) return;
      const clamped = Math.max(5000, base); // safety clamp
      const ms = withJitter(clamped, jitterPct);
      timerRef.current = setTimeout(runner, ms);
    },
    [intervalMs, jitterPct]
  );

  const run = useCallback(async () => {
    try {
      const res = await fetch('/api/devices/version', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        stoppedRef.current = true;
        return;
      }
      const data = await res.json().catch(() => null);
      const nextVersion = typeof data?.devicesVersion === 'number' ? data.devicesVersion : null;
      if (nextVersion !== null) {
        if (latestVersionRef.current === null) {
          latestVersionRef.current = nextVersion; // establish baseline without triggering refresh
        } else if (nextVersion !== latestVersionRef.current) {
          latestVersionRef.current = nextVersion;
          onVersionChangeRef.current?.();
        }
      }
    } catch {
      // ignore transient errors; retry on next tick
    } finally {
      scheduleNext(run);
    }
  }, [scheduleNext]);

  useEffect(() => {
    stoppedRef.current = false;
    latestVersionRef.current = null;
    scheduleNext(run, 1000); // start quickly
    return () => {
      stoppedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [run, scheduleNext]);
}
