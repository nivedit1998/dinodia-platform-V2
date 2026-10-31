-- Additive. Two-step verification by emailed code.
-- CustomerAccount: when the account turned it on (tenants opt in; homeowners and property managers are required by role),
-- and when the "turn it on" reminder was last put off.
-- AuthChallenge (the existing emailed-challenge table, which already has a hashed secret, attempts, expiry and delivery
-- state) gains a hash of the sign-in attempt it belongs to, a hash of the secret only the signing-in app holds, and a resend
-- counter. No backfill: every new column is nullable or has a safe default, and no table is added.
ALTER TABLE "CustomerAccount"
  ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
  ADD COLUMN "mfaPromptSnoozedUntil" TIMESTAMP(3),
  ADD COLUMN "mfaPromptDismissCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuthChallenge"
  ADD COLUMN "clientSecretHash" VARCHAR(64),
  ADD COLUMN "bindingHash" VARCHAR(64),
  ADD COLUMN "resendCount" INTEGER NOT NULL DEFAULT 0;
