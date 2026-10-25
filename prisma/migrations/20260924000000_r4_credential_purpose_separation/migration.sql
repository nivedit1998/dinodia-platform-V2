-- R4-01: machine and operator credential versions are separate authorities.
-- This migration is additive and never rewrites the foundation migration.

ALTER TABLE "HubInstallation"
  ADD COLUMN "currentMachineCredentialVersion" INTEGER,
  ADD COLUMN "currentOperatorCredentialVersion" INTEGER;

DROP INDEX IF EXISTS "HubCredentialVersion_hubInstallationId_version_key";

CREATE UNIQUE INDEX "HubCredentialVersion_hub_purpose_version_key"
  ON "HubCredentialVersion"("hubInstallationId", "purpose", "version");

UPDATE "HubInstallation" h
SET "currentOperatorCredentialVersion" = c.version
FROM "HubCredentialVersion" c
WHERE c."hubInstallationId" = h.id
  AND c.purpose = 'operator-credential'
  AND c.state IN ('ACTIVE', 'GRACE')
  AND c.version = (
    SELECT MAX(c2.version)
    FROM "HubCredentialVersion" c2
    WHERE c2."hubInstallationId" = h.id
      AND c2.purpose = 'operator-credential'
      AND c2.state IN ('ACTIVE', 'GRACE')
  );

UPDATE "HubInstallation" h
SET "currentMachineCredentialVersion" = c.version
FROM "HubCredentialVersion" c
WHERE c."hubInstallationId" = h.id
  AND c.purpose = 'machine-credential'
  AND c.state IN ('ACTIVE', 'GRACE')
  AND c.version = (
    SELECT MAX(c2.version)
    FROM "HubCredentialVersion" c2
    WHERE c2."hubInstallationId" = h.id
      AND c2.purpose = 'machine-credential'
      AND c2.state IN ('ACTIVE', 'GRACE')
  );
