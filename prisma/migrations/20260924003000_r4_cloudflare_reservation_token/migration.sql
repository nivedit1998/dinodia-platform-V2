-- R4-07: bind local Cloudflare creation to an installation-specific Platform
-- reservation before cloudflared creates the named tunnel.
ALTER TABLE "HubInstallation"
  ADD COLUMN "cloudflareReservationToken" VARCHAR(128);
