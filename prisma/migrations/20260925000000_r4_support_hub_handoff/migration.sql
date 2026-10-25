-- R4-03: keep employee support authority as an encrypted-to-hub envelope.
-- The envelope is never returned to Company Portal or rendered in the setup UI.
ALTER TABLE "SupportAccessRequest" ADD COLUMN "employeeHandoffEnvelope" TEXT;
