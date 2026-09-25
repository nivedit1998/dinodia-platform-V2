-- R6-01: the paired hub creates this browser-bound attempt before Portal
-- creates a handoff. No caller can replace the binding after registration.
CREATE TABLE "OperatorBrowserAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attemptId" VARCHAR(160) NOT NULL,
  "homeId" UUID NOT NULL,
  "hubInstallationId" UUID NOT NULL,
  "browserBindingHash" VARCHAR(128) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorBrowserAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperatorBrowserAttempt_attemptId_key" UNIQUE ("attemptId"),
  CONSTRAINT "OperatorBrowserAttempt_home_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OperatorBrowserAttempt_hub_home_fkey" FOREIGN KEY ("hubInstallationId", "homeId") REFERENCES "HubInstallation"("id", "homeId") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "OperatorHandoff"
  ADD COLUMN "operatorBrowserAttemptId" UUID,
  ADD CONSTRAINT "OperatorHandoff_browser_attempt_fkey"
    FOREIGN KEY ("operatorBrowserAttemptId") REFERENCES "OperatorBrowserAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OperatorBrowserAttempt_hub_expiry_idx"
  ON "OperatorBrowserAttempt"("hubInstallationId", "expiresAt", "consumedAt", "revokedAt");
CREATE INDEX "OperatorHandoff_operatorBrowserAttemptId_idx"
  ON "OperatorHandoff"("operatorBrowserAttemptId");
CREATE UNIQUE INDEX "OperatorHandoff_operatorBrowserAttemptId_key"
  ON "OperatorHandoff"("operatorBrowserAttemptId")
  WHERE "operatorBrowserAttemptId" IS NOT NULL;
