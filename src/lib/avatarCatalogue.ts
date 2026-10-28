import { sha256 } from './stage1Crypto';

/**
 * Tenant avatars (D21). Stable keys only: the phone maps each icon key to a symbol and each colour key to a
 * light/dark colour. Nothing user-supplied (text or images) is ever stored, so there is nothing to moderate.
 */
export const AVATAR_ICON_KEYS = [
  'tortoise', 'hare', 'lizard', 'bird', 'fish', 'ant', 'ladybug', 'cat',
  'dog', 'paw', 'teddy', 'carrot', 'popcorn', 'cake', 'tea', 'moon',
  'rocket', 'ufo', 'dice', 'puzzle', 'gamepad', 'guitar', 'headphones', 'skateboard',
  'surfboard', 'tent', 'mountain', 'umbrella', 'balloon', 'party', 'crown', 'masks',
] as const;

export const AVATAR_COLOUR_KEYS = [
  'tangerine', 'lemon', 'mint', 'teal', 'sky', 'indigo', 'grape', 'bubblegum', 'coral', 'slate',
] as const;

export type AvatarIconKey = typeof AVATAR_ICON_KEYS[number];
export type AvatarColourKey = typeof AVATAR_COLOUR_KEYS[number];
export type PublicAvatar = { icon: AvatarIconKey | null; colour: AvatarColourKey };

const iconSet = new Set<string>(AVATAR_ICON_KEYS);
const colourSet = new Set<string>(AVATAR_COLOUR_KEYS);

export function isAvatarIconKey(value: unknown): value is AvatarIconKey { return typeof value === 'string' && iconSet.has(value); }
export function isAvatarColourKey(value: unknown): value is AvatarColourKey { return typeof value === 'string' && colourSet.has(value); }

/** A stable default colour per account, so an account that never chose one still looks the same every time. */
export function defaultAvatarColour(accountId: string): AvatarColourKey {
  const value = parseInt(sha256(`avatar-colour\n${accountId}`).slice(0, 8), 16);
  return AVATAR_COLOUR_KEYS[value % AVATAR_COLOUR_KEYS.length];
}

/** The public form of a stored avatar. Unknown stored values (never written by this API) fall back safely. */
export function publicAvatar(account: { id: string; avatarIcon: string | null; avatarColour: string | null }): PublicAvatar {
  return {
    icon: isAvatarIconKey(account.avatarIcon) ? account.avatarIcon : null,
    colour: isAvatarColourKey(account.avatarColour) ? account.avatarColour : defaultAvatarColour(account.id),
  };
}

/**
 * An opaque per-viewer key for another tenant. It lets the phone recognise the same person across rooms
 * without learning any membership or account id; a different viewer receives a different key.
 */
export function sharedMemberKey(viewerMembershipId: string, targetMembershipId: string): string {
  return sha256(`shared-member\n${viewerMembershipId}\n${targetMembershipId}`).slice(0, 32);
}
