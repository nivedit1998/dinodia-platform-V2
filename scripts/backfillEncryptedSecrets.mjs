// Architecture: Repository maintenance or verification script scripts/backfillEncryptedSecrets.mjs; supports parity, generation, security, logging or operational checks outside request-time runtime code.
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function getKey() {
  const raw = process.env.PLATFORM_DATA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('PLATFORM_DATA_ENCRYPTION_KEY is not configured');
  }
  const buf = Buffer.from(raw, raw.length === 44 ? 'base64' : 'utf8');
  if (buf.length !== 32) {
    throw new Error('PLATFORM_DATA_ENCRYPTION_KEY must be 32 bytes (base64 recommended)');
  }
  return buf;
}

function encrypt(value) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function main() {
  const connections = await prisma.haConnection.findMany({
    select: {
      id: true,
      haUsername: true,
      haPassword: true,
      longLivedToken: true,
      haUsernameCiphertext: true,
      haPasswordCiphertext: true,
      longLivedTokenCiphertext: true,
      longLivedTokenHash: true,
    },
  });

  let updated = 0;

  for (const conn of connections) {
    const data = {};

    if (!conn.haUsernameCiphertext && conn.haUsername) {
      data.haUsernameCiphertext = encrypt(conn.haUsername);
      data.haUsername = null;
    }
    if (!conn.haPasswordCiphertext && conn.haPassword) {
      data.haPasswordCiphertext = encrypt(conn.haPassword);
      data.haPassword = null;
    }
    if (!conn.longLivedTokenCiphertext && conn.longLivedToken) {
      data.longLivedTokenCiphertext = encrypt(conn.longLivedToken);
      data.longLivedToken = null;
      data.longLivedTokenHash = conn.longLivedTokenHash ?? hashSecret(conn.longLivedToken);
    }

    if (Object.keys(data).length === 0) continue;

    await prisma.haConnection.update({ where: { id: conn.id }, data });
    updated += 1;
  }

  console.log(`Backfilled encrypted secrets for ${updated} Home Assistant connection(s).`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
