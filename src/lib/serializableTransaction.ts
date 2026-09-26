import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Retry only PostgreSQL serialization/deadlock conflicts. Callers must keep
 * externally visible side effects (mail, network calls, secret disclosure)
 * outside the callback so a retry is safe.
 */
export async function serializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (code !== 'P2034' || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 8 * (attempt + 1)));
    }
  }
  throw new Error('Serializable transaction exhausted without a result');
}
