// Architecture: Shared platform helper src/lib/clientDevice.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
'use client';

const STORAGE_KEY = 'dinodia_device_id';

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return 'unknown-device';
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = randomId();
  window.localStorage.setItem(STORAGE_KEY, id);
  return id;
}

export function getDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const platform = navigator.platform || 'Device';
  const userAgent = navigator.userAgent || '';
  const label = `${platform}${userAgent ? ` - ${userAgent}` : ''}`;
  return label.slice(0, 200);
}
