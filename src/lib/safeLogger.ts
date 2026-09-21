// Architecture: Shared platform helper src/lib/safeLogger.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';

type SafeLogInput = Record<string, unknown>;
type SafeLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_HASH_SALT =
  process.env.LOG_HASH_SALT ||
  process.env.JWT_SECRET ||
  process.env.PLATFORM_DATA_ENCRYPTION_KEY ||
  'dinodia-log-salt-v1';

const SENSITIVE_KEY_RE =
  /(password|passcode|secret|token|authorization|cookie|set-cookie|html|text|body|link|url|query|search|email)/i;
const HASH_KEY_RE =
  /^(ip|userId|homeId|tenantId|deviceId|serial|hubInstallId|haConnectionId|requestId)$/i;

const MAX_STRING_LEN = 240;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 16;
const MAX_DEPTH = 3;

function hashRaw(value: string): string {
  return crypto
    .createHash('sha256')
    .update(`${LOG_HASH_SALT}:${value}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LEN ? `${value.slice(0, MAX_STRING_LEN)}...` : value;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return summarizeError(value);
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      sliced.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return sliced;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeValue(entryValue, depth + 1);
    }
    return out;
  }

  return String(value);
}

export function hashForLog(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return hashRaw(normalized);
}

export function classifyUserAgent(value: string | null | undefined): string | null {
  const ua = String(value || '').toLowerCase();
  if (!ua) return null;
  if (ua.includes('okhttp')) return 'okhttp';
  if (ua.includes('cfnetwork')) return 'cfnetwork';
  if (ua.includes('dalvik')) return 'dalvik';
  if (ua.includes('postman')) return 'postman';
  if (ua.includes('curl')) return 'curl';
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('firefox/')) return 'firefox';
  if (ua.includes('chrome/')) return 'chrome';
  if (ua.includes('safari/')) return 'safari';
  return 'other';
}

export function summarizeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: truncateString(err.message || 'Unknown error'),
    };
  }
  return {
    name: 'UnknownError',
    message: truncateString(String(err)),
  };
}

export function sanitizeLogPayload(
  payload: SafeLogInput,
  options?: { allowKeys?: string[] }
): SafeLogInput {
  const allowed = options?.allowKeys ? new Set(options.allowKeys) : null;
  const out: SafeLogInput = {};

  for (const [key, value] of Object.entries(payload)) {
    if (allowed && !allowed.has(key)) continue;
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (HASH_KEY_RE.test(key) && value != null) {
      out[`${key}Hash`] = hashForLog(String(value));
      continue;
    }
    out[key] = sanitizeValue(value);
  }

  return out;
}

export function safeLog(level: SafeLogLevel, message: string, payload?: SafeLogInput): void {
  const safePayload = payload ? sanitizeLogPayload(payload) : undefined;

  if (level === 'debug') {
    if (process.env.NODE_ENV !== 'production') {
      if (safePayload) console.log(message, safePayload);
      else console.log(message);
    }
    return;
  }

  if (level === 'info') {
    if (safePayload) console.log(message, safePayload);
    else console.log(message);
    return;
  }

  if (level === 'warn') {
    if (safePayload) console.warn(message, safePayload);
    else console.warn(message);
    return;
  }

  if (safePayload) console.error(message, safePayload);
  else console.error(message);
}
