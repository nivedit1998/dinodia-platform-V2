// Architecture: Repository maintenance or verification script scripts/checkEmailUniqueness.mjs; supports parity, generation, security, logging or operational checks outside request-time runtime code.
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeEmail(user) {
  const raw = (user.emailPending || user.email || '').trim();
  return raw ? raw.toLowerCase() : '';
}

function groupName(role) {
  if (role === Role.TENANT) return 'TENANT';
  if (role === Role.ADMIN || role === Role.INSTALLER) return 'ADMINLIKE';
  return String(role);
}

function pushMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      role: true,
      homeId: true,
      email: true,
      emailPending: true,
      emailVerifiedAt: true,
    },
  });

  const tenantMap = new Map();
  const adminLikeMap = new Map();
  const warnings = [];

  for (const u of users) {
    if (u.email && u.emailPending) {
      warnings.push(
        `[WARN] userId=${u.id} username=${u.username} role=${u.role} has both email and emailPending set (email=${u.email}, emailPending=${u.emailPending})`
      );
    }

    const norm = normalizeEmail(u);
    if (!norm) continue;

    if (u.role === Role.TENANT) {
      pushMap(tenantMap, norm, u);
    } else if (u.role === Role.ADMIN || u.role === Role.INSTALLER) {
      pushMap(adminLikeMap, norm, u);
    }
  }

  let failures = 0;

  function reportDuplicates(label, map) {
    for (const [email, rows] of map.entries()) {
      if (rows.length <= 1) continue;
      failures += 1;
      console.log(`\n[DUPLICATE:${label}] ${email} (${rows.length} users)`);
      for (const r of rows) {
        console.log(
          `  - userId=${r.id} username=${r.username} role=${r.role} homeId=${r.homeId ?? 'null'} email=${r.email ?? 'null'} emailPending=${r.emailPending ?? 'null'} verifiedAt=${r.emailVerifiedAt ? r.emailVerifiedAt.toISOString() : 'null'}`
        );
      }
    }
  }

  reportDuplicates('TENANT', tenantMap);
  reportDuplicates('ADMINLIKE', adminLikeMap);

  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(w);
  }

  // Optional: check global “>2 rows share same email” across tenant/adminlike (should never happen after enforcing).
  const global = new Map();
  for (const u of users) {
    const norm = normalizeEmail(u);
    if (!norm) continue;
    pushMap(global, norm, u);
  }
  for (const [email, rows] of global.entries()) {
    const tenantCount = rows.filter((r) => r.role === Role.TENANT).length;
    const adminLikeCount = rows.filter((r) => r.role === Role.ADMIN || r.role === Role.INSTALLER).length;
    if (tenantCount > 1 || adminLikeCount > 1 || tenantCount + adminLikeCount > 2) {
      failures += 1;
      console.log(`\n[INVALID:GLOBAL] ${email}`);
      const groups = rows
        .map((r) => `${groupName(r.role)}:${r.username}(id=${r.id})`)
        .join(', ');
      console.log(`  users: ${groups}`);
    }
  }

  if (failures > 0) {
    console.error(`\nFAILED: found ${failures} email uniqueness violation(s). Fix these before deploying DB constraints.`);
    process.exit(1);
  }

  console.log('\nOK: no email uniqueness violations found.');
}

main()
  .catch((err) => {
    console.error('Email uniqueness check failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
