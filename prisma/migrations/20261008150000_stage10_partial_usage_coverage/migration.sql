-- Stage 10: preserve the actually observed span inside an hourly aggregate.
-- NULL remains the explicit legacy representation so old durable envelopes
-- and existing history remain readable without destructive backfill.
ALTER TABLE "NativeDeviceUsageBucket"
  ADD COLUMN "coverageStartAt" TIMESTAMP(3),
  ADD COLUMN "coverageEndAt" TIMESTAMP(3);

-- A closed partial hour is valid only when the exact span is present. Preserve
-- existing legacy full-hour rows while removing the old all-closed-hours-must
-- total-3600 restriction that rejected the first partial hour.
ALTER TABLE "NativeDeviceUsageBucket"
  DROP CONSTRAINT "NativeUsage_duration_check";

ALTER TABLE "NativeDeviceUsageBucket"
  ADD CONSTRAINT "NativeUsage_duration_check"
  CHECK (
    "onSeconds" >= 0
    AND "offSeconds" >= 0
    AND "unknownSeconds" >= 0
    AND "onSeconds" + "offSeconds" + "unknownSeconds" <= 3600
    AND (
      "closedAt" IS NULL
      OR (
        "closedAt" = "bucketStart" + INTERVAL '1 hour'
        AND (
          "onSeconds" + "offSeconds" + "unknownSeconds" = 3600
          OR ("coverageStartAt" IS NOT NULL AND "coverageEndAt" IS NOT NULL)
        )
      )
    )
  );

ALTER TABLE "NativeDeviceUsageBucket"
  ADD CONSTRAINT "NativeDeviceUsageBucket_coverage_span_check"
  CHECK (
    ("coverageStartAt" IS NULL AND "coverageEndAt" IS NULL)
    OR (
      "coverageStartAt" IS NOT NULL
      AND "coverageEndAt" IS NOT NULL
      AND "coverageStartAt" >= "bucketStart"
      AND "coverageEndAt" <= "bucketStart" + INTERVAL '1 hour'
      AND "coverageEndAt" > "coverageStartAt"
      AND ("closedAt" IS NULL OR ("closedAt" = "bucketStart" + INTERVAL '1 hour' AND "coverageEndAt" = "closedAt"))
      AND extract(epoch FROM ("coverageEndAt" - "coverageStartAt")) * 1000
        = ("onSeconds" + "offSeconds" + "unknownSeconds") * 1000
    )
  );
