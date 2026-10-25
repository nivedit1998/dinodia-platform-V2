-- R7: durable first-CXO delivery state and audited work creation.
-- Invitation plaintext is never stored; only delivery state and a hash live here.
CREATE TYPE "BootstrapDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CONSUMED', 'REVOKED');

ALTER TABLE "InitialCxoBootstrap"
  ADD COLUMN "deliveryStatus" "BootstrapDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeliveryAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryFailureCode" VARCHAR(80);

CREATE INDEX "InitialCxoBootstrap_deliveryStatus_idx"
  ON "InitialCxoBootstrap"("deliveryStatus", "invitationExpiresAt");
