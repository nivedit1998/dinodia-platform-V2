import { PrismaClient } from '../generated/prisma';
import type { PrismaClient as StablePrismaClient } from '@prisma/client';
import { runtimeDatabaseUrl } from './runtimeDatabaseUrl';

const globalForPrisma = globalThis as unknown as { prisma?: StablePrismaClient };
// Keep existing callers on their published type surface while the runtime
// client includes additive schema expansion. New state-table operations use
// explicitly typed parameterized SQL during the compatibility rollout.
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: runtimeDatabaseUrl(),
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
}) as unknown as StablePrismaClient;
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
