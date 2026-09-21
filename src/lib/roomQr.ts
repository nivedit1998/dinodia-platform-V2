// Architecture: Shared platform helper src/lib/roomQr.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import 'server-only';

import crypto from 'crypto';
import { decryptSecret, encryptSecret, generateRandomHex, hashSha256 } from '@/lib/hubCrypto';

const ROOM_QR_VERSION = '1';

export type ParsedRoomQr = {
  version: string;
  roomId: string;
  token: string;
};

export function generateRoomQrSecret(): string {
  return generateRandomHex(32);
}

export function encryptRoomQrSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptRoomQrSecret(ciphertext: string): string {
  return decryptSecret(ciphertext);
}

export function hashRoomQrSecret(secret: string): string {
  return hashSha256(secret);
}

function getQrLaunchBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (envUrl) return envUrl.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`.replace(/\/$/, '');
  return 'http://localhost:3000';
}

export function buildRoomQrPayload(args: { roomId: string; token: string; version?: string }): string {
  const roomId = args.roomId.trim();
  const token = args.token.trim();
  const version = (args.version ?? ROOM_QR_VERSION).trim();
  const query = new URLSearchParams({ v: version, rid: roomId, t: token });
  return `${getQrLaunchBaseUrl()}/qr/room?${query.toString()}`;
}

export function parseRoomQrPayload(raw: string): ParsedRoomQr | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;

  if (text.toLowerCase().startsWith('dinodia://')) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== 'room') return null;
    const version = parsed.searchParams.get('v') ?? ROOM_QR_VERSION;
    const roomId = parsed.searchParams.get('rid') ?? '';
    const token = parsed.searchParams.get('t') ?? '';
    if (!roomId.trim() || !token.trim()) return null;
    return { version, roomId: roomId.trim(), token: token.trim() };
  }

  if (text.toLowerCase().startsWith('http://') || text.toLowerCase().startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname !== '/qr/room') return null;
    const version = parsed.searchParams.get('v') ?? ROOM_QR_VERSION;
    const roomId = parsed.searchParams.get('rid') ?? '';
    const token = parsed.searchParams.get('t') ?? '';
    if (!roomId.trim() || !token.trim()) return null;
    return { version, roomId: roomId.trim(), token: token.trim() };
  }

  // Allow JSON payloads for debugging tools / alternate encoders
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const version = typeof obj.v === 'string' ? obj.v : ROOM_QR_VERSION;
      const roomId = typeof obj.rid === 'string' ? obj.rid : typeof obj.roomId === 'string' ? obj.roomId : '';
      const token = typeof obj.t === 'string' ? obj.t : typeof obj.token === 'string' ? obj.token : '';
      if (!roomId.trim() || !token.trim()) return null;
      return { version: String(version), roomId: roomId.trim(), token: token.trim() };
    } catch {
      return null;
    }
  }

  return null;
}

export function safeEqualHex(a: string, b: string): boolean {
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (!aa || !bb) return false;
  try {
    const abuf = Buffer.from(aa, 'hex');
    const bbuf = Buffer.from(bb, 'hex');
    if (abuf.length !== bbuf.length) return false;
    return crypto.timingSafeEqual(abuf, bbuf);
  } catch {
    return false;
  }
}
