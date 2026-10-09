import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Retry only PostgreSQL serialization/deadlock conflicts. Callers must keep
 * externally visible side effects (mail, network calls, secret disclosure)
 * outside the callback so a retry is safe.
 */
export function isRetryableSerializationConflict(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null
    ? error as { code?: unknown; meta?: { code?: unknown; sqlState?: unknown; sqlstate?: unknown } }
    : {};
  const prismaCode = String(record.code ?? '');
  const sqlState = String(record.meta?.code ?? record.meta?.sqlState ?? record.meta?.sqlstate ?? '');
  // Prisma reports serializable conflicts as P2034 and raw PostgreSQL
  // deadlocks/serialization failures as P2010 with SQLSTATE in meta.
  return prismaCode === 'P2034' || prismaCode === '40P01' || prismaCode === '40001'
    || (prismaCode === 'P2010' && (sqlState === '40P01' || sqlState === '40001'));
}

export async function serializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 4,
  transactionBounds: { maxWaitMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(transactionBounds.maxWaitMs ? { maxWait: transactionBounds.maxWaitMs } : {}),
        ...(transactionBounds.timeoutMs ? { timeout: transactionBounds.timeoutMs } : {}),
      });
    } catch (error) {
      // Retrying is safe only when callbacks contain database work; network,
      // email, secret disclosure and other external effects stay outside.
      if (!isRetryableSerializationConflict(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 8 * (attempt + 1)));
    }
  }
  throw new Error('Serializable transaction exhausted without a result');
}
