// Architecture: Shared platform helper src/lib/claimCode.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const CLAIM_CODE_PREFIX = 'DND';
const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function requirePepper() {
  const pepper = process.env.CLAIM_CODE_PEPPER;
  if (!pepper) {
    throw new Error('CLAIM_CODE_PEPPER is not configured.');
  }
  return pepper;
}

function randomChars(length: number) {
  let output = '';
  for (let i = 0; i < length; i++) {
    const idx = crypto.randomInt(0, CLAIM_CODE_ALPHABET.length);
    output += CLAIM_CODE_ALPHABET[idx];
  }
  return output;
}

export function generateClaimCode(): string {
  return `${CLAIM_CODE_PREFIX}-${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;
}

export function normalizeClaimCode(code: string): string {
  return code.trim().replace(/\s+/g, '').toUpperCase();
}

export function hashClaimCode(code: string): string {
  const normalized = normalizeClaimCode(code);
  if (!normalized) {
    throw new Error('Claim code is required for hashing.');
  }
  const pepper = requirePepper();
  const payload = `${pepper}:${normalized}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function verifyClaimCode(input: string, storedHash: string): boolean {
  const computed = hashClaimCode(input);
  const computedBuf = Buffer.from(computed, 'hex');
  const storedBuf = Buffer.from(storedHash ?? '', 'hex');
  if (computedBuf.length !== storedBuf.length || computedBuf.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(computedBuf, storedBuf);
}

export async function setHomeClaimCode(homeId: number): Promise<{ claimCode: string }> {
  return setHomeClaimCodeWithClient(prisma, homeId);
}

type HomeUpdateClient = {
  home: {
    update: (args: Prisma.HomeUpdateArgs) => Promise<unknown>;
  };
};

export async function setHomeClaimCodeWithClient(
  client: HomeUpdateClient,
  homeId: number
): Promise<{ claimCode: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimCode = generateClaimCode();
    const claimCodeHash = hashClaimCode(claimCode);

    try {
      await client.home.update({
        where: { id: homeId },
        data: {
          claimCodeHash,
          claimCodeIssuedAt: new Date(),
          claimCodeConsumedAt: null,
        },
      });
      return { claimCode };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Unable to generate a unique claim code. Please try again.');
}

export async function findHomeByClaimCode(code: string) {
  const claimCodeHash = hashClaimCode(code);
  return prisma.home.findUnique({
    where: { claimCodeHash },
  });
}
