-- R7: durable privacy-scoped notifications for property-level support access.
-- Tenant-private support deliberately creates no notification row.
CREATE TABLE "SupportAccessNotification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recipientAccountId" UUID NOT NULL,
  "homeId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "accessRequestId" UUID NOT NULL,
  "sessionId" UUID,
  "eventType" VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportAccessNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportAccessNotification_recipient_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessNotification_home_fkey" FOREIGN KEY ("homeId") REFERENCES "Home"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessNotification_ticket_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessNotification_request_fkey" FOREIGN KEY ("accessRequestId") REFERENCES "SupportAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAccessNotification_session_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SupportAccessNotification_recipient_request_event_key"
  ON "SupportAccessNotification"("recipientAccountId", "accessRequestId", "eventType");
CREATE INDEX "SupportAccessNotification_recipient_created_idx"
  ON "SupportAccessNotification"("recipientAccountId", "createdAt");
CREATE INDEX "SupportAccessNotification_home_created_idx"
  ON "SupportAccessNotification"("homeId", "createdAt");
CREATE INDEX "SupportAccessNotification_ticket_event_idx"
  ON "SupportAccessNotification"("ticketId", "eventType");
