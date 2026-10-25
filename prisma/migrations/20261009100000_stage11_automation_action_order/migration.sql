-- Preserve the order already used by the Stage 3 cloud projection before
-- replacing its UUID ordering with the explicit V1 action order.
ALTER TABLE "NativeAutomationAction" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER;

WITH ordered_actions AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "automationId" ORDER BY "id" ASC) - 1 AS position
  FROM "NativeAutomationAction"
)
UPDATE "NativeAutomationAction" AS action
SET "sortOrder" = ordered_actions.position
FROM ordered_actions
WHERE action."id" = ordered_actions."id" AND action."sortOrder" IS NULL;

ALTER TABLE "NativeAutomationAction" ALTER COLUMN "sortOrder" SET DEFAULT 0;
ALTER TABLE "NativeAutomationAction" ALTER COLUMN "sortOrder" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "NativeAutomationAction_automationId_sortOrder_idx"
  ON "NativeAutomationAction"("automationId", "sortOrder");

-- A minimal marker lets the owner see that a property-impacting rule is still
-- awaiting hub removal without retaining its private definition or actions.
ALTER TABLE "NativeAutomation" ADD COLUMN IF NOT EXISTS "propertyImpact" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "NativeAutomation" ALTER COLUMN "createdByMembershipId" DROP NOT NULL;
ALTER TABLE "NativeAutomation" DROP CONSTRAINT IF EXISTS "NativeAutomation_createdByMembershipId_fkey";
ALTER TABLE "NativeAutomation" ADD CONSTRAINT "NativeAutomation_createdByMembershipId_fkey"
  FOREIGN KEY ("createdByMembershipId") REFERENCES "HomeMembership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
UPDATE "NativeAutomation" automation
SET "propertyImpact" = TRUE
WHERE EXISTS (
  SELECT 1 FROM "NativeAutomationAction" action
  JOIN "NativeDevice" device ON device."id" = action."deviceId"
  WHERE action."automationId" = automation."id"
    AND device."managementClass" = 'PROPERTY_DEVICE'
);
