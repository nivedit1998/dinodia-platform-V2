-- Stage 1: bind each customer session to the exact trusted-device generation.
ALTER TABLE "CustomerSession" ADD COLUMN "trustedDeviceSessionVersion" INTEGER NOT NULL DEFAULT 1;

UPDATE "CustomerSession" AS session
SET "trustedDeviceSessionVersion" = device."sessionVersion"
FROM "TrustedDevice" AS device
WHERE device.id = session."trustedDeviceId";
