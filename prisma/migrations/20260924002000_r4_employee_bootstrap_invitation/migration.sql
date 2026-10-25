-- R4-08: first employee bootstrap creates a pending invitation. It never
-- accepts the employee's final password or marks email verified.
ALTER TYPE "EmployeeStatus" ADD VALUE IF NOT EXISTS 'PENDING';

ALTER TABLE "CompanyEmployeeAccount"
  ADD COLUMN "username" VARCHAR(80),
  ADD COLUMN "bootstrapInvitationHash" VARCHAR(128),
  ADD COLUMN "bootstrapInvitationExpiresAt" TIMESTAMP(3),
  ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE UNIQUE INDEX "CompanyEmployeeAccount_username_key"
  ON "CompanyEmployeeAccount"("username");
CREATE UNIQUE INDEX "CompanyEmployeeAccount_bootstrapInvitationHash_key"
  ON "CompanyEmployeeAccount"("bootstrapInvitationHash");

ALTER TABLE "InitialCxoBootstrap"
  ADD COLUMN "invitationHash" VARCHAR(128),
  ADD COLUMN "invitationExpiresAt" TIMESTAMP(3);
