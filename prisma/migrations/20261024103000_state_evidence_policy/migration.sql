-- Additive reader preparation only. Existing epochs/buckets retain their original policy.
ALTER TABLE "NativeAnalyticsInterval"
  ADD COLUMN "analyticsPolicyVersion" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "NativeAnalyticsInterval" ADD CONSTRAINT "analytics_interval_policy_version"
  CHECK ("analyticsPolicyVersion" IN (2, 3));
ALTER TABLE "NativeDeviceUsageBucket" DROP CONSTRAINT "usage_writer_version";
ALTER TABLE "NativeDeviceUsageBucket" ADD CONSTRAINT "usage_writer_version" CHECK
  (("bindingRevision" = 0 AND "analyticsPolicyVersion" = 1 AND "analyticsIntervalId" IS NULL)
   OR ("bindingRevision" > 0 AND "analyticsPolicyVersion" IN (2, 3) AND "analyticsIntervalId" IS NOT NULL));
ALTER TABLE "NativeTemperatureSample" ADD COLUMN "analyticsPolicyVersion" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "NativeTemperatureSample" ADD COLUMN "currentnessEndedAt" TIMESTAMP(3);
ALTER TABLE "NativeTemperatureSample" DROP CONSTRAINT "NativeTemperatureSample_valid_until_check";
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperatureSample_valid_until_check" CHECK (
  ("analyticsPolicyVersion" = 2 AND "validUntil" > "sourceObservedAt" AND "validUntil" <= "sourceObservedAt" + INTERVAL '30 minutes')
  OR ("analyticsPolicyVersion" = 3 AND "validUntil" >= "sourceObservedAt" AND "validUntil" <= "sourceObservedAt" + INTERVAL '65595 seconds')
);
ALTER TABLE "NativeTemperatureSample" ADD CONSTRAINT "NativeTemperatureSample_currentness_ended_check" CHECK (
  "currentnessEndedAt" IS NULL OR ("currentnessEndedAt" >= "sourceObservedAt" AND "currentnessEndedAt" <= "validUntil")
);
