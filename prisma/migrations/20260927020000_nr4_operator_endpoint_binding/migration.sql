-- Freeze the transport selected by the originating locked browser attempt.
-- NULL remains valid for historical attempts; new attempts require all fields.
ALTER TABLE "OperatorBrowserAttempt"
  ADD COLUMN "accessMode" VARCHAR(16),
  ADD COLUMN "endpointOrigin" VARCHAR(500),
  ADD COLUMN "endpointRevision" INTEGER;

ALTER TABLE "OperatorBrowserAttempt"
  ADD CONSTRAINT "OperatorBrowserAttempt_endpoint_binding_check"
  CHECK (
    ("accessMode" IS NULL AND "endpointOrigin" IS NULL AND "endpointRevision" IS NULL)
    OR
    ("accessMode" = 'secure' AND "endpointOrigin" IS NOT NULL AND "endpointRevision" = 0)
    OR
    ("accessMode" = 'local' AND "endpointOrigin" IS NOT NULL AND "endpointRevision" > 0)
  );

CREATE INDEX "OperatorBrowserAttempt_endpoint_binding_idx"
  ON "OperatorBrowserAttempt" ("hubInstallationId", "accessMode", "endpointRevision", "expiresAt");
