import { PrismaClient } from '@prisma/client';
import { runtimeDatabaseUrl } from './runtimeDatabaseUrl';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: runtimeDatabaseUrl(),
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
