/**
 * Spoken names for Alexa devices: "Bedroom lamp". Pure and deterministic so the same device always gets the same name
 * until something about it (or a clashing device) changes.
 */
const WAKE_WORDS = new Set(['alexa', 'echo', 'amazon', 'computer', 'ziggy']);
export const MAX_FRIENDLY_NAME = 128;

function clean(value: string): string {
  return value.normalize('NFC').replace(/[^\p{L}\p{N}' \-&]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function withoutWakeWords(value: string): string {
  return value.split(' ').filter((word) => !WAKE_WORDS.has(word.toLowerCase())).join(' ').trim();
}

function words(value: string): string[] {
  return clean(value).toLowerCase().split(' ').filter(Boolean);
}

/** True when every word of the room's name already appears in the device name ("Bedroom lamp" in room "Bedroom"). */
function mentionsRoom(deviceName: string, roomName: string): boolean {
  const room = words(roomName);
  if (room.length === 0) return true;
  const device = new Set(words(deviceName));
  return room.every((word) => device.has(word));
}

export function baseFriendlyName(deviceName: string, roomName: string | null): string {
  const device = withoutWakeWords(clean(deviceName)) || 'Device';
  const room = roomName ? withoutWakeWords(clean(roomName)) : '';
  const combined = room && !mentionsRoom(device, room) ? `${room} ${device}` : device;
  return combined.slice(0, MAX_FRIENDLY_NAME).trim();
}

export type FriendlyNameInput = {
  key: string;            // endpoint or device id, unique in the account
  deviceName: string;
  roomName: string | null;
  homeKey: string;
  postcode: string;
  order: number;          // creation order, so earlier devices keep the plain name
};

/**
 * Names for every endpoint of one account. A clash between different Homes adds the postcode; a clash inside one Home
 * numbers the later devices ("Bedroom lamp 2").
 */
export function chooseFriendlyNames(items: FriendlyNameInput[]): Map<string, string> {
  const sorted = [...items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const base = new Map<string, string>(sorted.map((item) => [item.key, baseFriendlyName(item.deviceName, item.roomName)]));
  const byName = new Map<string, FriendlyNameInput[]>();
  for (const item of sorted) {
    const name = base.get(item.key)!.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  const result = new Map<string, string>();
  for (const group of byName.values()) {
    const homes = new Set(group.map((item) => item.homeKey));
    const perHomeCount = new Map<string, number>();
    for (const item of group) {
      let name = base.get(item.key)!;
      if (homes.size > 1) {
        const postcode = item.postcode.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '');
        if (postcode) name = `${name.slice(0, MAX_FRIENDLY_NAME - postcode.length - 1)} ${postcode}`;
      }
      const seen = (perHomeCount.get(item.homeKey) ?? 0) + 1;
      perHomeCount.set(item.homeKey, seen);
      if (seen > 1) name = `${name.slice(0, MAX_FRIENDLY_NAME - 4)} ${seen}`;
      result.set(item.key, name);
    }
  }
  // A numbered or postcoded name can itself collide with another device's plain name: make the final names unique.
  const used = new Set<string>();
  for (const item of sorted) {
    let name = result.get(item.key)!;
    let n = 2;
    while (used.has(name.toLowerCase())) { name = `${(base.get(item.key) ?? name).slice(0, MAX_FRIENDLY_NAME - 6)} ${n}`; n += 1; }
    used.add(name.toLowerCase());
    result.set(item.key, name);
  }
  return result;
}
