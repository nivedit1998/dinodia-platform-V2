-- R4-02: store only an encrypted-to-hub handoff secret envelope alongside its
-- one-use hash. The plaintext secret is never returned to the browser.
ALTER TABLE "OperatorHandoff" ADD COLUMN "handoffEnvelope" TEXT;

-- Existing local Stage 1 handoffs were issued before the hub-secret exchange
-- existed. They must not remain consumable under the new protocol.
UPDATE "OperatorHandoff" SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP), "handoffEnvelope" = '' WHERE "handoffEnvelope" IS NULL;

ALTER TABLE "OperatorHandoff" ALTER COLUMN "handoffEnvelope" SET NOT NULL;
