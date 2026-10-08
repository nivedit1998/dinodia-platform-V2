-- A closed support ticket retained for Home audit can be safely redacted
-- during full-home deregistration. It may keep its Home scope while both
-- customer and selected-membership authority are cleared. Active scoped
-- tickets still require an exact membership/account/Home binding.
CREATE OR REPLACE FUNCTION dinodia_validate_stage1_ticket_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_account uuid; membership_home uuid;
BEGIN
  IF NEW."selectedMembershipId" IS NULL THEN
    -- Preserve unlinked public Get Help records. A Home-scoped row without a
    -- membership is permitted only after the existing cleanup owner has
    -- closed and redacted it. Do not admit an account-linked row with no
    -- membership, even when it has no Home.
    IF NEW."customerAccountId" IS NULL AND NEW."homeId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW."customerAccountId" IS NULL
       AND NEW."homeId" IS NOT NULL
       AND NEW."status" = 'CLOSED'
       AND NEW."closedAt" IS NOT NULL
       AND NEW."description" IN ('[Closed and redacted after relationship removal]', '[Closed and redacted after full-home deregistration]')
       AND NEW."title" IS NULL
       AND NEW."areaId" IS NULL
       AND NEW."deviceId" IS NULL
       AND NEW."safeDiagnostics" IS NULL
       AND NEW."customerResolution" IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'support ticket membership must belong to the ticket customer and home';
  END IF;

  SELECT "customerAccountId", "homeId" INTO membership_account, membership_home
    FROM "HomeMembership" WHERE "id" = NEW."selectedMembershipId";
  IF membership_home IS DISTINCT FROM NEW."homeId"
     OR membership_account IS DISTINCT FROM NEW."customerAccountId" THEN
    RAISE EXCEPTION 'support ticket membership must belong to the ticket customer and home';
  END IF;
  RETURN NEW;
END; $$;
