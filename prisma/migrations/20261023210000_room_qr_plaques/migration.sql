-- Additive only. An existing ambiguous active set must stop rather than rotate labels.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "AreaQrCredential" WHERE "status"='ACTIVE' GROUP BY "areaId" HAVING count(*)>1)
  THEN RAISE EXCEPTION 'Room QR preflight: multiple active credentials require explicit reconciliation'; END IF;
END $$;
CREATE TYPE "RoomPlaqueStatus" AS ENUM ('REQUESTED','IN_PRODUCTION','DISPATCHED','COMPLETED','CANCELLED');
CREATE TYPE "RoomPlaqueKind" AS ENUM ('FIRST_ISSUE','REPRINT');
CREATE TABLE "RoomPlaqueRequest" (
  "id" UUID NOT NULL PRIMARY KEY,
  "publicReference" VARCHAR(40) NOT NULL,
  "homeId" UUID NOT NULL REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requesterAccountId" UUID REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "requesterMembershipId" UUID REFERENCES "HomeMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "requesterRole" VARCHAR(32) NOT NULL,
  "authorityGeneration" INTEGER NOT NULL CHECK ("authorityGeneration">0),
  "addressFingerprint" VARCHAR(64) NOT NULL,
  "encryptedAddress" JSONB NOT NULL,
  "status" "RoomPlaqueStatus" NOT NULL DEFAULT 'REQUESTED',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0),
  "notes" VARCHAR(1000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "productionStartedAt" TIMESTAMP(3), "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3)
);
CREATE TABLE "RoomPlaqueRequestItem" (
  "id" UUID NOT NULL PRIMARY KEY,
  "requestId" UUID NOT NULL REFERENCES "RoomPlaqueRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "areaId" UUID NOT NULL REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" "RoomPlaqueKind" NOT NULL,
  "roomLabelSnapshot" VARCHAR(160) NOT NULL,
  "credentialId" UUID REFERENCES "AreaQrCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "credentialGeneration" INTEGER,
  "closedAt" TIMESTAMP(3),
  CHECK (("credentialId" IS NULL) = ("credentialGeneration" IS NULL)),
  CHECK ("credentialGeneration" IS NULL OR "credentialGeneration">0),
  CHECK ("kind" <> 'REPRINT' OR "credentialId" IS NOT NULL)
);
CREATE UNIQUE INDEX "RoomPlaqueRequest_publicReference_key" ON "RoomPlaqueRequest"("publicReference");
CREATE INDEX "RoomPlaqueRequest_homeId_createdAt_id_idx" ON "RoomPlaqueRequest"("homeId","createdAt","id");
CREATE INDEX "RoomPlaqueRequest_status_createdAt_id_idx" ON "RoomPlaqueRequest"("status","createdAt","id");
CREATE UNIQUE INDEX "RoomPlaqueRequestItem_requestId_areaId_key" ON "RoomPlaqueRequestItem"("requestId","areaId");
CREATE INDEX "RoomPlaqueRequestItem_areaId_closedAt_idx" ON "RoomPlaqueRequestItem"("areaId","closedAt");
CREATE UNIQUE INDEX "AreaQrCredential_one_active_area" ON "AreaQrCredential"("areaId") WHERE "status"='ACTIVE';
CREATE UNIQUE INDEX "RoomPlaqueRequestItem_one_open_area" ON "RoomPlaqueRequestItem"("areaId") WHERE "closedAt" IS NULL;
