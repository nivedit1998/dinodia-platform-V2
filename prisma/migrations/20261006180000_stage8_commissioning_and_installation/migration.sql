-- Stage 8 links assigned permanent-installation work and canonical devices to
-- the existing Stage 3 request authority. No household rows are fabricated.
ALTER TYPE "CompanyWorkKind" ADD VALUE 'PERMANENT_DEVICE_INSTALLATION';

ALTER TABLE "PermanentDeviceInstallationRequest"
  ALTER COLUMN "requesterMembershipId" DROP NOT NULL,
  ADD COLUMN "requesterAccountId" UUID;

ALTER TABLE "PermanentDeviceInstallationRequest"
  DROP CONSTRAINT "PermanentDeviceInstallationRequest_requesterMembershipId_fkey";
ALTER TABLE "PermanentDeviceInstallationRequest"
  ADD CONSTRAINT "PermanentDeviceInstallationRequest_requesterMembershipId_fkey"
  FOREIGN KEY ("requesterMembershipId") REFERENCES "HomeMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CompanyOperationalWorkItem"
  ADD COLUMN "permanentInstallationRequestId" UUID;
CREATE UNIQUE INDEX "CompanyOperationalWorkItem_permanentInstallationRequestId_key"
  ON "CompanyOperationalWorkItem"("permanentInstallationRequestId");
ALTER TABLE "CompanyOperationalWorkItem"
  ADD CONSTRAINT "CompanyOperationalWorkItem_permanentInstallationRequestId_fkey"
  FOREIGN KEY ("permanentInstallationRequestId") REFERENCES "PermanentDeviceInstallationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NativeDevice"
  ADD COLUMN "installationRequestId" UUID;
CREATE INDEX "NativeDevice_installationRequestId_idx" ON "NativeDevice"("installationRequestId");
ALTER TABLE "NativeDevice"
  ADD CONSTRAINT "NativeDevice_installationRequestId_fkey"
  FOREIGN KEY ("installationRequestId") REFERENCES "PermanentDeviceInstallationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NativeCommissioningSession"
  ALTER COLUMN "requestingMembershipId" DROP NOT NULL,
  ADD COLUMN "requestingEmployeeId" UUID,
  ADD COLUMN "permanentInstallationRequestId" UUID,
  ADD COLUMN "workItemId" UUID,
  ADD COLUMN "employeeSessionId" UUID,
  ADD COLUMN "operatorHandoffId" UUID,
  ADD COLUMN "workRevision" INTEGER,
  ADD COLUMN "selectedCandidateRef" VARCHAR(80),
  ADD COLUMN "selectedOsDeviceId" VARCHAR(160),
  ADD COLUMN "catalogueStatus" VARCHAR(32),
  ADD COLUMN "catalogueRevision" INTEGER,
  ADD COLUMN "catalogueDigest" VARCHAR(64),
  ADD COLUMN "finalDisposition" VARCHAR(24);

ALTER TABLE "NativeCommissioningSession"
  ADD CONSTRAINT "NativeCommissioningSession_requestingEmployeeId_fkey"
    FOREIGN KEY ("requestingEmployeeId") REFERENCES "CompanyEmployeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NativeCommissioningSession_permanentInstallationRequestId_fkey"
    FOREIGN KEY ("permanentInstallationRequestId") REFERENCES "PermanentDeviceInstallationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NativeCommissioningSession_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "CompanyOperationalWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NativeCommissioningSession_staff_actor_check" CHECK (
    ("requestingMembershipId" IS NOT NULL AND "requestingEmployeeId" IS NULL AND "permanentInstallationRequestId" IS NULL AND "workItemId" IS NULL AND "employeeSessionId" IS NULL AND "operatorHandoffId" IS NULL AND "workRevision" IS NULL)
    OR
    ("requestingMembershipId" IS NULL AND "requestingEmployeeId" IS NOT NULL AND "permanentInstallationRequestId" IS NOT NULL AND "workItemId" IS NOT NULL AND "employeeSessionId" IS NOT NULL AND "operatorHandoffId" IS NOT NULL AND "workRevision" IS NOT NULL)
  );
CREATE INDEX "NativeCommissioningSession_requestingEmployeeId_state_idx" ON "NativeCommissioningSession"("requestingEmployeeId", "state");
CREATE INDEX "NativeCommissioningSession_permanentInstallationRequestId_state_idx" ON "NativeCommissioningSession"("permanentInstallationRequestId", "state");
