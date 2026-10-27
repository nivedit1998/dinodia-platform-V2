import { PrismaClient } from '../generated/prisma';
import { runtimeDatabaseUrl } from './runtimeDatabaseUrl';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
// TypeScript/Next resolve @prisma/client to this same worktree-local generated
// client. Clean builds never depend on an older shared node_modules client.
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: runtimeDatabaseUrl(),
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
