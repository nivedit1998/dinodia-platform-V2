/**
 * Wording for every account notice Dinodia sends by banner and email: access to rooms and Homes, Alexa linking, and new
 * devices installed by Dinodia. Pure (no database, no network) so the exact text can be tested.
 *
 * The details a notice quotes (a person, a room, a Home, a device list) travel inside the encrypted outbox envelope and are
 * only decrypted at send time. Banners stay short enough for a lock screen; emails carry the full detail.
 */
export type NoticeKind = 'ROOM_ACCESS_REQUEST' | 'ROOM_ACCESS_APPROVED' | 'ROOM_ACCESS_DECLINED' | 'ACCESS_CHANGED' | 'ALEXA_LINKED' | 'NEW_DEVICES';

export const NOTICE_EVENT_KIND: Readonly<Record<string, NoticeKind>> = {
  ROOM_ACCESS_REQUEST_NOTICE: 'ROOM_ACCESS_REQUEST',
  ROOM_ACCESS_APPROVED_NOTICE: 'ROOM_ACCESS_APPROVED',
  ROOM_ACCESS_DECLINED_NOTICE: 'ROOM_ACCESS_DECLINED',
  TENANT_ACCESS_REMOVAL_NOTICE: 'ACCESS_CHANGED',
  PROPERTY_MANAGER_ACCESS_REMOVAL_NOTICE: 'ACCESS_CHANGED',
  OWNERSHIP_TRANSFER_NOTICE: 'ACCESS_CHANGED',
  HOME_DEREGISTRATION_NOTICE: 'ACCESS_CHANGED',
  ALEXA_LINKED_NOTICE: 'ALEXA_LINKED',
  NEW_DEVICES_NOTICE: 'NEW_DEVICES',
};

export type NoticeDevice = { name: string; room: string };
export type NoticeDetails = {
  homeLabel?: string; roomName?: string; requesterName?: string; requesterEmail?: string;
  /** ISO time the thing happened. */
  at?: string;
  /** ACCESS_CHANGED only: which removal this is, and the role the person held. */
  removal?: 'TENANT' | 'PROPERTY_MANAGER' | 'OWNERSHIP_TRANSFER' | 'FULL_HOME_DEREGISTRATION'; role?: 'OWNER' | 'PROPERTY_MANAGER' | 'TENANT';
  /** NEW_DEVICES only. */
  devices?: NoticeDevice[]; reference?: string; audience?: 'OWNER' | 'TENANT';
};

export type NoticeContent = {
  kind: NoticeKind; pushTitle: string; pushBody: string; subject: string; heading: string;
  paragraphs: string[]; facts: Array<[string, string]>; list: string[]; button: string;
};

export const NOTICE_APP_LINK = 'https://dinodia-platform-v2.vercel.app/app';
const MAX_TEXT = 120;
const MAX_LIST = 12;

function clean(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT) : fallback;
}

function formatWhen(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function plural(count: number, one: string, many: string): string { return count === 1 ? one : many; }

function deviceLines(devices: NoticeDevice[] | undefined): { lines: string[]; count: number; rooms: string[] } {
  const all = (Array.isArray(devices) ? devices : []).map((device) => ({ name: clean(device?.name, 'New device'), room: clean(device?.room) }));
  const shown = all.slice(0, MAX_LIST).map((device) => (device.room ? `${device.name} · ${device.room}` : device.name));
  if (all.length > MAX_LIST) shown.push(`and ${all.length - MAX_LIST} more`);
  const rooms = [...new Set(all.map((device) => device.room).filter(Boolean))];
  return { lines: shown, count: all.length, rooms };
}

/** A short list for a banner: "Kitchen", "Kitchen and Hall", "Kitchen, Hall and 2 more rooms". */
function roomPhrase(rooms: string[]): string {
  if (rooms.length === 0) return '';
  if (rooms.length === 1) return rooms[0];
  if (rooms.length === 2) return `${rooms[0]} and ${rooms[1]}`;
  return `${rooms[0]}, ${rooms[1]} and ${rooms.length - 2} more rooms`;
}

export function composeNotice(eventType: string, details: NoticeDetails = {}): NoticeContent | null {
  const kind = NOTICE_EVENT_KIND[eventType];
  if (!kind) return null;
  const home = clean(details.homeLabel, 'your Home');
  const room = clean(details.roomName, 'a room');
  const when = formatWhen(details.at);
  const base = { kind, facts: [] as Array<[string, string]>, list: [] as string[] };

  if (kind === 'ROOM_ACCESS_REQUEST') {
    const who = clean(details.requesterName, 'Someone');
    const email = clean(details.requesterEmail);
    const facts: Array<[string, string]> = [['Person', who]];
    if (email) facts.push(['Email', email]);
    facts.push(['Room', room], ['Home', home]);
    if (when) facts.push(['Asked', when]);
    return { ...base, facts,
      pushTitle: 'Room access request',
      pushBody: `${who} would like to use ${room}. Tap to review and approve.`,
      subject: `${who} has asked for access to ${room}`,
      heading: 'A new room access request',
      paragraphs: [
        `${who}${email ? ` (${email})` : ''} has asked for access to ${room} at ${home}.`,
        'Open Dinodia to approve or decline. Approving lets them control the devices in that room only, nothing else in your Home.',
        'If you do not recognise them, decline the request. Nothing changes until you decide.',
      ],
      button: 'Review the request' };
  }
  if (kind === 'ROOM_ACCESS_APPROVED') {
    const facts: Array<[string, string]> = [['Room', room], ['Home', home]];
    return { ...base, facts,
      pushTitle: 'Room access approved',
      pushBody: `You can now use ${room}. Tap to open Dinodia and choose your Home.`,
      subject: `You now have access to ${room}`,
      heading: 'You’re all set',
      paragraphs: [
        `Good news, your request to use ${room} at ${home} has been approved.`,
        'Open the Dinodia Smart Living app, choose your Home and you can control the devices in that room straight away.',
      ],
      button: 'Open Dinodia' };
  }
  if (kind === 'ROOM_ACCESS_DECLINED') {
    return { ...base, facts: [['Room', room], ['Home', home]],
      pushTitle: 'Room access not approved',
      pushBody: `Your request to use ${room} wasn’t approved.`,
      subject: 'Your room access request wasn’t approved',
      heading: 'Your request wasn’t approved',
      paragraphs: [
        `Your request to use ${room} at ${home} wasn’t approved.`,
        'If you think this is a mistake, please speak to the homeowner or property manager. They can approve a new request any time.',
      ],
      button: 'Open Dinodia' };
  }
  if (kind === 'ACCESS_CHANGED') {
    const facts: Array<[string, string]> = [['Home', home]];
    if (when) facts.push(['When', when]);
    const stay = 'Your Dinodia account is still active, and any other Homes you belong to are not affected.';
    if (details.removal === 'PROPERTY_MANAGER') {
      return { ...base, facts,
        pushTitle: 'Your manager access has ended',
        pushBody: `You are no longer a property manager for ${home}. Tap to see your Homes.`,
        subject: `Your property manager access to ${home} has ended`,
        heading: 'Your manager access has ended',
        paragraphs: [`The homeowner has removed you as a property manager for ${home}. You can no longer manage that Home or its people.`, stay], button: 'Open Dinodia' };
    }
    if (details.removal === 'OWNERSHIP_TRANSFER') {
      const wasOwner = details.role === 'OWNER';
      return { ...base, facts,
        pushTitle: wasOwner ? 'Ownership transferred' : 'Your manager access has ended',
        pushBody: wasOwner ? `${home} now has a new homeowner. Tap to see your Homes.` : `Ownership of ${home} changed, so your manager access has ended.`,
        subject: wasOwner ? `Ownership of ${home} has been transferred` : `Your property manager access to ${home} has ended`,
        heading: wasOwner ? 'Ownership has been transferred' : 'Your manager access has ended',
        paragraphs: [wasOwner
          ? `Ownership of ${home} has been transferred to a new homeowner. You are no longer the homeowner and can no longer manage that Home.`
          : `Ownership of ${home} was transferred to a new homeowner, so your property manager access has ended.`, stay], button: 'Open Dinodia' };
    }
    if (details.removal === 'FULL_HOME_DEREGISTRATION') {
      return { ...base, facts,
        pushTitle: 'Home removed from Dinodia',
        pushBody: `${home} has been removed from Dinodia, so your access has ended.`,
        subject: `${home} has been removed from Dinodia`,
        heading: 'This Home has been removed',
        paragraphs: [`${home} has been deregistered from Dinodia Smart Living, so everyone’s access to it has ended.`, stay], button: 'Open Dinodia' };
    }
    return { ...base, facts,
      pushTitle: 'Your access has ended',
      pushBody: `You no longer have access to ${home}. Tap to see your other Homes.`,
      subject: `Your access to ${home} has ended`,
      heading: 'Your access has ended',
      paragraphs: [`The homeowner has removed your access to ${home}. You can no longer control devices there, and Alexa will stop showing them shortly.`, stay,
        'If you think this is a mistake, ask the homeowner to approve a new room request for you.'], button: 'Open Dinodia' };
  }
  if (kind === 'ALEXA_LINKED') {
    const facts: Array<[string, string]> = [];
    if (when) facts.push(['Linked', when]);
    return { ...base, facts,
      pushTitle: 'Alexa is linked',
      pushBody: 'Alexa can now control the devices in your rooms. Wasn’t you? Open Dinodia to unlink it.',
      subject: 'Alexa is now linked to your Dinodia account',
      heading: 'Alexa is linked',
      paragraphs: [
        'Alexa has been linked to your Dinodia Smart Living account. You can now ask Alexa to control the devices in the rooms you have access to.',
        'Alexa only ever sees rooms you have access to, and it keeps up automatically if your access changes.',
        'If this wasn’t you, open Dinodia, go to Settings, then Alexa, and unlink it. We also recommend changing your password.',
      ],
      button: 'Open Dinodia' };
  }
  // NEW_DEVICES: only devices Dinodia installed. Devices tenants add themselves are never included.
  const { lines, count, rooms } = deviceLines(details.devices);
  if (count === 0) return null;
  const owner = details.audience !== 'TENANT';
  const noun = plural(count, 'device', 'devices');
  const facts: Array<[string, string]> = [['Home', home]];
  if (details.reference) facts.push(['Request', clean(details.reference)]);
  if (when) facts.push(['Finished', when]);
  return { ...base, facts, list: lines,
    pushTitle: 'New devices installed',
    pushBody: owner
      ? `Dinodia added ${count} new ${noun}${rooms.length ? ` in ${roomPhrase(rooms)}` : ''}. Tap to see what’s new.`
      : `${count} new ${noun} added${rooms.length ? ` in ${roomPhrase(rooms)}` : ''}. Tap to open Dinodia.`,
    subject: owner ? `Dinodia has finished installing ${count} new ${noun}` : `${count} new ${noun} ${plural(count, 'has', 'have')} been added to your rooms`,
    heading: owner ? 'Your new devices are installed' : 'New devices in your rooms',
    paragraphs: owner
      ? [`Dinodia has finished the installation at ${home}${details.reference ? ` (request ${clean(details.reference)})` : ''}. Here is what was added:`,
        'They are ready to use now. Open Dinodia to see them, rename them or add them to automations.']
      : [`Dinodia has installed new ${noun} in rooms you have access to at ${home}. Here is what was added:`,
        'Open Dinodia to start using them. Devices you add yourself are never shared with anyone else.'],
    button: 'Open Dinodia' };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Plain-text and HTML bodies for one notice: a clean card, a small table of facts, an optional list, and one button. */
export function noticeEmail(content: NoticeContent): { subject: string; text: string; html: string } {
  const textParts = [content.heading, '', content.paragraphs[0]];
  if (content.list.length) textParts.push('', ...content.list.map((line) => `• ${line}`));
  if (content.paragraphs.length > 1) textParts.push('', ...content.paragraphs.slice(1).flatMap((paragraph, index) => (index ? ['', paragraph] : [paragraph])));
  if (content.facts.length) textParts.push('', ...content.facts.map(([label, value]) => `${label}: ${value}`));
  textParts.push('', `${content.button}: ${NOTICE_APP_LINK}`, '', 'Dinodia Smart Living');
  const cell = 'padding-top:14px;font-size:16px;line-height:1.5;color:#3a3a3c;';
  const row = (value: string) => `<tr><td style="${cell}">${escapeHtml(value)}</td></tr>`;
  const factsHtml = content.facts.length
    ? `<tr><td style="padding-top:18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;border-radius:12px;padding:6px 16px;">`
      + content.facts.map(([label, value]) => `<tr><td style="padding:8px 0;font-size:13px;color:#6c6c70;width:34%;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:8px 0;font-size:15px;color:#1c1c1e;font-weight:600;vertical-align:top;">${escapeHtml(value)}</td></tr>`).join('')
      + `</table></td></tr>`
    : '';
  const listHtml = content.list.length
    ? `<tr><td style="padding-top:12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">`
      + content.list.map((line) => `<tr><td style="padding:6px 0;font-size:16px;color:#1c1c1e;border-bottom:1px solid #eceff3;">${escapeHtml(line)}</td></tr>`).join('')
      + `</table></td></tr>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px;">`
    + `<tr><td style="font-size:13px;font-weight:600;letter-spacing:.04em;color:#0a84ff;text-transform:uppercase;">Dinodia Smart Living</td></tr>`
    + `<tr><td style="padding-top:12px;font-size:22px;font-weight:700;line-height:1.3;">${escapeHtml(content.heading)}</td></tr>`
    + row(content.paragraphs[0]) + listHtml + content.paragraphs.slice(1).map(row).join('') + factsHtml
    + `<tr><td style="padding-top:24px;"><a href="${NOTICE_APP_LINK}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 24px;border-radius:12px;">${escapeHtml(content.button)}</a></td></tr>`
    + `<tr><td style="padding-top:28px;font-size:12px;line-height:1.5;color:#8e8e93;">You are receiving this because of activity on your Dinodia Smart Living account.</td></tr>`
    + `</table></td></tr></table></body></html>`;
  return { subject: content.subject, text: textParts.join('\n'), html };
}
