ALTER TABLE "HomeClaimReference"
  ADD COLUMN "transferRecipientEmailHash" VARCHAR(128),
  ADD COLUMN "transferRecipientEmail" VARCHAR(320),
  ADD COLUMN "transferEmailDeliveryStatus" VARCHAR(24);

ALTER TABLE "HomeClaimReference"
  ADD CONSTRAINT "HomeClaimReference_transfer_email_status_check"
  CHECK ("transferEmailDeliveryStatus" IS NULL OR "transferEmailDeliveryStatus" IN ('PENDING', 'ACCEPTED', 'FAILED'));
