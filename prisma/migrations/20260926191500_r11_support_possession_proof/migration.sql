-- Store only the public half of the per-request employee-proof signing key.
-- The private key is delivered inside the existing hub-encrypted envelope.
ALTER TABLE "SupportAccessRequest"
  ADD COLUMN "employeeProofPublicKey" TEXT;
