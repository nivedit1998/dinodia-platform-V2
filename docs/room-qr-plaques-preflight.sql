-- Read-only, counts-only release preflight. Run against the verified target.
-- No credential references, ciphertext, addresses or account data are returned.
BEGIN TRANSACTION READ ONLY;
SELECT count(*) AS ambiguous_active_area_count FROM (
  SELECT "areaId" FROM "AreaQrCredential" WHERE "status" = 'ACTIVE'
  GROUP BY "areaId" HAVING count(*) > 1
) AS ambiguous;
SELECT count(*) AS active_credentials,
  count(*) FILTER (WHERE "encryptedPrintablePayload" IS NULL) AS active_hash_only_credentials
FROM "AreaQrCredential" WHERE "status" = 'ACTIVE';
SELECT count(*) AS homes FROM "Home";
SELECT count(*) AS areas FROM "Area";
SELECT count(*) AS memberships FROM "HomeMembership";
SELECT count(*) AS grants FROM "TenantAreaGrant";
SELECT migration_name, checksum FROM "_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name;
COMMIT;
