-- R4-02: bind operator handoffs to the originating setup attempt and browser.
-- The values are hashes only; no browser binding or handoff secret is stored.

ALTER TABLE "OperatorHandoff"
  ADD COLUMN "setupAttemptId" VARCHAR(160),
  ADD COLUMN "browserBindingHash" VARCHAR(128);

-- Existing pre-R4 handoffs are deliberately made unusable rather than
-- inventing a valid browser binding. Fresh handoffs are always populated by
-- the transaction that creates them.
UPDATE "OperatorHandoff"
SET "setupAttemptId" = COALESCE("setupAttemptId", 'legacy-' || "id"::text),
    "browserBindingHash" = COALESCE("browserBindingHash", repeat('0', 64));

ALTER TABLE "OperatorHandoff"
  ALTER COLUMN "setupAttemptId" SET NOT NULL,
  ALTER COLUMN "browserBindingHash" SET NOT NULL;

CREATE INDEX "OperatorHandoff_setupAttemptId_idx"
  ON "OperatorHandoff"("setupAttemptId");
