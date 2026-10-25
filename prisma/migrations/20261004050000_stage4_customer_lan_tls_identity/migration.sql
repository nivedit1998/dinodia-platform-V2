-- Stage 4 customer LAN TLS identity and authenticated pin acknowledgement.
-- All columns are additive and nullable/defaulted so the existing enrolled
-- installation and application rollback remain usable before pin publication.
ALTER TABLE "HubInstallation"
  ADD COLUMN "publicHubId" VARCHAR(20),
  ADD COLUMN "lanTlsRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lanTlsReportedAt" TIMESTAMP(3),
  ADD COLUMN "lanTlsState" VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "lanTlsIdentityGeneration" INTEGER,
  ADD COLUMN "lanTlsCertificateGeneration" INTEGER,
  ADD COLUMN "lanTlsCurrentSpkiPin" VARCHAR(64),
  ADD COLUMN "lanTlsCurrentNotBefore" TIMESTAMP(3),
  ADD COLUMN "lanTlsCurrentNotAfter" TIMESTAMP(3),
  ADD COLUMN "lanTlsNextCertificateGeneration" INTEGER,
  ADD COLUMN "lanTlsNextSpkiPin" VARCHAR(64),
  ADD COLUMN "lanTlsNextNotBefore" TIMESTAMP(3),
  ADD COLUMN "lanTlsNextNotAfter" TIMESTAMP(3),
  ADD COLUMN "lanTlsAcknowledgedGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "HubInstallation_publicHubId_key"
  ON "HubInstallation"("publicHubId");

ALTER TABLE "HubInstallation"
  ADD CONSTRAINT "HubInstallation_lanTlsRevision_nonnegative" CHECK ("lanTlsRevision" >= 0),
  ADD CONSTRAINT "HubInstallation_lanTlsAcknowledgedGeneration_nonnegative" CHECK ("lanTlsAcknowledgedGeneration" >= 0);
