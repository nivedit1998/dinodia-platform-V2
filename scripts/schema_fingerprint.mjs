import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
function canonicalRows(rows) {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
try {
  const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const columns = await prisma.$queryRaw`SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
  const constraints = await prisma.$queryRaw`SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY table_name, conname`;
  const indexes = await prisma.$queryRaw`SELECT tablename AS table_name, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`;
  const functions = await prisma.$queryRaw`SELECT n.nspname AS schema_name, p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY function_name, arguments`;
  const triggers = await prisma.$queryRaw`SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(pg_trigger.oid) AS definition FROM pg_trigger JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace WHERE NOT tgisinternal AND pg_namespace.nspname = 'public' ORDER BY table_name, tgname`;
  const payload = JSON.stringify({
    tables: canonicalRows(tables),
    columns: canonicalRows(columns),
    constraints: canonicalRows(constraints),
    indexes: canonicalRows(indexes),
    functions: canonicalRows(functions),
    triggers: canonicalRows(triggers),
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  const fingerprint = crypto.createHash('sha256').update(payload).digest('hex');
  console.log(JSON.stringify({ fingerprint, tableCount: tables.length, columnCount: columns.length, constraintCount: constraints.length, indexCount: indexes.length }));
} finally {
  await prisma.$disconnect();
}
