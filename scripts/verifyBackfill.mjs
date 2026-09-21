// Architecture: Repository maintenance or verification script scripts/verifyBackfill.mjs; supports parity, generation, security, logging or operational checks outside request-time runtime code.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function extractCount(row) {
  return row && typeof row.count === 'number' ? row.count : 0;
}

async function main() {
  const [missingHomes] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "HaConnection" hc
    LEFT JOIN "Home" h ON h."haConnectionId" = hc."id"
    WHERE h."id" IS NULL
  `;

  const [usersMissingHome] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "User"
    WHERE "homeId" IS NULL
  `;

  const [usersMismatchedHome] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "User" u
    JOIN "Home" h ON h."id" = u."homeId"
    WHERE u."haConnectionId" IS NOT NULL
      AND u."haConnectionId" <> h."haConnectionId"
  `;

  const duplicateHomes = await prisma.$queryRaw`
    SELECT "haConnectionId", COUNT(*)::int AS "homeCount"
    FROM "Home"
    GROUP BY "haConnectionId"
    HAVING COUNT(*) > 1
  `;

  console.log('HaConnections missing a Home:', extractCount(missingHomes));
  console.log('Users missing homeId:', extractCount(usersMissingHome));
  console.log('Users mapped to a Home for a different connection:', extractCount(usersMismatchedHome));

  if (duplicateHomes.length > 0) {
    console.log('Connections with multiple Home rows:');
    duplicateHomes.forEach((row) => {
      console.log(`- haConnectionId=${row.haConnectionId} has ${row.homeCount} homes`);
    });
  } else {
    console.log('Connections with multiple Home rows: 0');
  }
}

main()
  .catch((error) => {
    console.error('Backfill verification failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
