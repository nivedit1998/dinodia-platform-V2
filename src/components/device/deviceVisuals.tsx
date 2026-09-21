// Architecture: Reusable web UI component src/components/device/deviceVisuals.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import { JSX } from 'react';
import { UIDevice } from '@/types/device';
import { getBrightnessPercent } from '@/lib/deviceCapabilities';
import { formatTemperature } from './DeviceControls';

export type IconProps = { className?: string };
export type DeviceVisual = {
  label: string;
  size: 'small' | 'medium' | 'large';
  activeBg: string;
  inactiveBg: string;
  iconActiveBg: string;
  iconInactiveBg: string;
  detailAccent: string;
  icon: (props: IconProps) => JSX.Element;
};

const DEFAULT_VISUAL: DeviceVisual = {
  label: 'Device',
  size: 'medium',
  activeBg: 'bg-gradient-to-br from-indigo-100/80 via-white to-indigo-50/70',
  inactiveBg: 'bg-white/80',
  iconActiveBg: 'bg-indigo-600 text-white',
  iconInactiveBg: 'bg-white/70 text-indigo-500',
  detailAccent: 'from-indigo-50 to-white',
  icon: (props) => <GenericIcon {...props} />,
};

const VISUALS: Record<string, DeviceVisual> = {
  Light: {
    label: 'Light',
    size: 'small',
    activeBg: 'bg-gradient-to-br from-indigo-100/90 via-violet-50/80 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-indigo-600 text-white',
    iconInactiveBg: 'bg-white/70 text-indigo-500',
    detailAccent: 'from-indigo-50 to-white',
    icon: (props) => <LightIcon {...props} />,
  },
  Blind: {
    label: 'Blind',
    size: 'medium',
    activeBg: 'bg-gradient-to-br from-sky-100/90 via-cyan-50/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-sky-500 text-white',
    iconInactiveBg: 'bg-white/70 text-sky-500',
    detailAccent: 'from-sky-50 to-white',
    icon: (props) => <BlindIcon {...props} />,
  },
  'Motion Sensor': {
    label: 'Motion Sensor',
    size: 'small',
    activeBg: 'bg-gradient-to-br from-emerald-100/90 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-emerald-500 text-white',
    iconInactiveBg: 'bg-white/70 text-emerald-500',
    detailAccent: 'from-emerald-50 to-white',
    icon: (props) => <MotionIcon {...props} />,
  },
  Spotify: {
    label: 'Spotify',
    size: 'large',
    activeBg: 'bg-gradient-to-br from-emerald-200/90 via-emerald-100/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-emerald-600 text-white',
    iconInactiveBg: 'bg-white/70 text-emerald-600',
    detailAccent: 'from-emerald-50 to-white',
    icon: (props) => <SpotifyIcon {...props} />,
  },
  Boiler: {
    label: 'Boiler',
    size: 'medium',
    activeBg: 'bg-gradient-to-br from-orange-100/90 via-amber-50/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-orange-500 text-white',
    iconInactiveBg: 'bg-white/70 text-orange-500',
    detailAccent: 'from-orange-50 to-white',
    icon: (props) => <BoilerIcon {...props} />,
  },
  Radiator: {
    label: 'Radiator',
    size: 'medium',
    activeBg: 'bg-gradient-to-br from-orange-100/90 via-amber-50/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-orange-500 text-white',
    iconInactiveBg: 'bg-white/70 text-orange-500',
    detailAccent: 'from-orange-50 to-white',
    icon: (props) => <BoilerIcon {...props} />,
  },
  Sockets: {
    label: 'Sockets',
    size: 'small',
    activeBg: 'bg-gradient-to-br from-slate-100/90 via-slate-50/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-slate-800 text-white',
    iconInactiveBg: 'bg-white/70 text-slate-600',
    detailAccent: 'from-slate-50 to-white',
    icon: (props) => <PlugIcon {...props} />,
  },
  Doorbell: {
    label: 'Doorbell',
    size: 'small',
    activeBg: 'bg-gradient-to-br from-amber-100/80 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-amber-400 text-amber-950',
    iconInactiveBg: 'bg-white/70 text-amber-400',
    detailAccent: 'from-amber-50 to-white',
    icon: (props) => <DoorbellIcon {...props} />,
  },
  'Home Security': {
    label: 'Home Security',
    size: 'large',
    activeBg: 'bg-gradient-to-br from-indigo-100/90 via-blue-50/70 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-indigo-500 text-white',
    iconInactiveBg: 'bg-white/70 text-indigo-500',
    detailAccent: 'from-indigo-50 to-white',
    icon: (props) => <SecurityIcon {...props} />,
  },
  TV: {
    label: 'TV',
    size: 'medium',
    activeBg: 'bg-gradient-to-br from-indigo-100/80 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-indigo-500 text-white',
    iconInactiveBg: 'bg-white/70 text-indigo-500',
    detailAccent: 'from-indigo-50 to-white',
    icon: (props) => <TvIcon {...props} />,
  },
  Speaker: {
    label: 'Speaker',
    size: 'medium',
    activeBg: 'bg-gradient-to-br from-indigo-100/80 to-white',
    inactiveBg: 'bg-white/80',
    iconActiveBg: 'bg-indigo-500 text-white',
    iconInactiveBg: 'bg-white/70 text-indigo-500',
    detailAccent: 'from-indigo-50 to-white',
    icon: (props) => <SpeakerIcon {...props} />,
  },
};

export function getVisualPreset(label: string): DeviceVisual {
  return VISUALS[label] ?? DEFAULT_VISUAL;
}

export function tileSizeClasses(size: DeviceVisual['size']) {
  switch (size) {
    case 'large':
      return 'min-h-[190px] sm:min-h-[220px] lg:col-span-2';
    case 'medium':
      return 'min-h-[160px] sm:min-h-[180px]';
    default:
      return 'min-h-[140px] sm:min-h-[150px]';
  }
}

export function getDeviceArea(device: UIDevice) {
  return (device.displayAreaName ?? device.areaName ?? device.area ?? 'Unassigned') || 'Unassigned';
}

export function getDeviceSecondaryText(label: string, device: UIDevice) {
  const attrs = device.attributes || {};
  switch (label) {
    case 'Light': {
      const brightness = getBrightnessPercent(attrs);
      if (device.state === 'on' && brightness !== null) {
        return `${brightness}% brightness`;
      }
      return capitalizeState(device.state);
    }
    case 'Blind': {
      const rawPosition =
        typeof attrs.current_position === 'number'
          ? (attrs.current_position as number)
          : typeof attrs.position === 'number'
          ? (attrs.position as number)
          : null;
      if (rawPosition !== null) {
        const position = Math.round(Math.min(100, Math.max(0, rawPosition)));
        return `${position}% open`;
      }
      return capitalizeState(device.state);
    }
    case 'Motion Sensor':
      if (isMotionActive(device.state)) return 'Motion detected';
      return 'No motion';
    case 'Spotify':
      return (
        readAttr<string>(attrs, 'media_title') ||
        (device.state === 'playing' ? 'Playing' : 'Paused')
      );
    case 'Boiler':
      return `Target ${formatTemperature(attrs.temperature)}`;
    case 'Sockets': {
      const unit = readAttr<string>(attrs, 'unit_of_measurement');
      const state = device.state?.toString?.() ?? '';
      if (unit) return `${state} ${unit}`.trim();
      return state || 'No data';
    }
    case 'Doorbell':
      return device.state ? capitalizeState(device.state) : 'Idle';
    case 'Home Security':
      return 'Camera grid';
    case 'TV':
    case 'Speaker':
      return readAttr<string>(attrs, 'media_title') || capitalizeState(device.state);
    default:
      return capitalizeState(device.state);
  }
}

export function isDeviceActive(label: string, device: UIDevice) {
  const state = device.state.toLowerCase();
  switch (label) {
    case 'Light':
    case 'Spotify':
    case 'TV':
    case 'Speaker':
      return state === 'on' || state === 'playing';
    case 'Blind':
      return state === 'open' || state === 'opening';
    case 'Boiler':
      return true;
    case 'Sockets': {
      const numeric = Number(state);
      if (!Number.isNaN(numeric)) return numeric > 0;
      return state === 'on';
    }
    case 'Doorbell':
    case 'Home Security':
      return true;
    case 'Motion Sensor':
      return isMotionActive(state);
    default:
      return state !== 'off';
  }
}

function isMotionActive(rawState: string) {
  const state = rawState?.toString()?.toLowerCase?.() ?? '';
  if (state === 'on' || state === 'motion' || state === 'detected' || state === 'open') {
    return true;
  }
  const numeric = Number(state);
  if (!Number.isNaN(numeric)) {
    return numeric > 0;
  }
  return false;
}

export function getDeviceIcon(label: string) {
  return getVisualPreset(label).icon;
}

export function getDetailAccent(label: string) {
  return getVisualPreset(label).detailAccent;
}

function capitalizeState(state: string) {
  return state
    ? state
        .toString()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Unknown';
}

function readAttr<T>(attrs: Record<string, unknown>, key: string) {
  const value = attrs[key];
  return value as T | undefined;
}

function LightIcon({ className = '' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M9 18h6m-4 3h2m3-12a4 4 0 10-8 0c0 1.755-.649 3.08-1.74 4.755C11.8 18 12 21 12 21"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BlindIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path d="M4 5h16M4 9h16M6 13h12M8 17h8" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MotionIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path
        d="M12 5a7 7 0 017 7m-2 0a5 5 0 00-5-5m-6.5.5A9.5 9.5 0 112 12"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpotifyIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.5 12.8a.9.9 0 01-1.24.3 8.3 8.3 0 00-6.53-.7.9.9 0 01-.58-1.7 10.1 10.1 0 017.96.85.9.9 0 01.39 1.25zm.53-3.09a1 1 0 01-1.37.35 11 11 0 00-8.66-.92 1 1 0 11-.54-1.94 12.9 12.9 0 0110.17 1.1 1 1 0 01.4 1.41zm.18-3.17a1.1 1.1 0 01-1.5.43A13.7 13.7 0 006.7 7.5a1.1 1.1 0 01-.66-2.1 15.5 15.5 0 0110.38 1.16 1.1 1.1 0 01.79 1.96z" />
    </svg>
  );
}

function BoilerIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path
        d="M12 3a4 4 0 014 4v5a4 4 0 11-8 0V7a4 4 0 014-4zm0 0v18"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DoorbellIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path
        d="M12 4a4 4 0 00-4 4v4l-1.5 3h11L16 12V8a4 4 0 00-4-4zm0 13v2"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SecurityIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path
        d="M12 3l7 3v6c0 4.28-2.99 8.23-7 9-4.01-.77-7-4.72-7-9V6l7-3z"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TvIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <rect x="3" y="5" width="18" height="12" rx="2.5" strokeWidth="1.5" />
      <path d="M8 19h8" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SpeakerIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <rect x="7" y="3" width="10" height="18" rx="2" strokeWidth="1.5" />
      <circle cx="12" cy="15" r="3" strokeWidth="1.5" />
      <circle cx="12" cy="7" r="1" fill="currentColor" />
    </svg>
  );
}

function PlugIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <path d="M9 3v6M15 3v6" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="7" y="9" width="10" height="6" rx="2" strokeWidth="1.5" />
      <path d="M12 15v4" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 19h4" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GenericIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} stroke="currentColor" fill="none">
      <circle cx="12" cy="12" r="7" strokeWidth="1.5" />
      <path d="M12 9v3l2 2" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
