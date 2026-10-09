type QuietHoursDocument = {
  version: 1;
  enabled: boolean;
  startLocalTime: string;
  endLocalTime: string;
  timeZone: string;
  days: number[];
};

const weekdayNumber: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function parseQuietHours(value: unknown): QuietHoursDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join('|') !== ['days', 'enabled', 'endLocalTime', 'startLocalTime', 'timeZone', 'version'].sort().join('|')
    || document.version !== 1 || typeof document.enabled !== 'boolean'
    || typeof document.startLocalTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(document.startLocalTime)
    || typeof document.endLocalTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(document.endLocalTime)
    || document.startLocalTime === document.endLocalTime || typeof document.timeZone !== 'string'
    || document.timeZone.length > 64 || !Array.isArray(document.days)
    || document.days.length < 1 || document.days.length > 7
    || !document.days.every((day) => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7)
    || new Set(document.days).size !== document.days.length) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: document.timeZone }); } catch { return null; }
  return document as QuietHoursDocument;
}

function localParts(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = Object.fromEntries(values.map((part) => [part.type, part.value]));
  const weekday = weekdayNumber[value.weekday ?? ''];
  const hour = Number(value.hour);
  const minute = Number(value.minute);
  if (!weekday || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { weekday, minuteOfDay: hour * 60 + minute };
}

function isQuietAt(date: Date, document: QuietHoursDocument): boolean | null {
  const parts = localParts(date, document.timeZone);
  if (!parts) return null;
  const start = Number(document.startLocalTime.slice(0, 2)) * 60 + Number(document.startLocalTime.slice(3));
  const end = Number(document.endLocalTime.slice(0, 2)) * 60 + Number(document.endLocalTime.slice(3));
  const todayEnabled = document.days.includes(parts.weekday);
  const previousWeekday = parts.weekday === 1 ? 7 : parts.weekday - 1;
  const previousEnabled = document.days.includes(previousWeekday);
  return start < end
    ? todayEnabled && parts.minuteOfDay >= start && parts.minuteOfDay < end
    : todayEnabled && parts.minuteOfDay >= start || previousEnabled && parts.minuteOfDay < end;
}

/** Returns null for malformed policy; otherwise the earliest safe instant outside quiet hours. */
export function nextAllowedAutomationNotificationAt(now: Date, rawQuietHours: unknown): Date | null {
  if (!Number.isFinite(now.getTime())) return null;
  if (rawQuietHours === null || rawQuietHours === undefined) return new Date(now);
  const quiet = parseQuietHours(rawQuietHours);
  if (!quiet) return null;
  if (!quiet.enabled) return new Date(now);
  const current = isQuietAt(now, quiet);
  if (current === null) return null;
  if (!current) return new Date(now);
  const firstMinute = Math.floor(now.getTime() / 60_000) + 1;
  // A valid weekly quiet-hours schedule must exit within 24 hours. The extra
  // margin tolerates DST transitions without making a malformed policy open.
  for (let minute = firstMinute; minute <= firstMinute + 36 * 60; minute += 1) {
    const candidate = new Date(minute * 60_000);
    const inside = isQuietAt(candidate, quiet);
    if (inside === null) return null;
    if (!inside) return candidate;
  }
  return null;
}
