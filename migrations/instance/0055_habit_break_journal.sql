-- A break is a restriction. After restoring an older snapshot, conservatively pause
-- the affected habit until a participant can inspect and resume it. No break dates or text
-- are copied to the gateway journal.
ALTER TABLE pactaris.revocation_journal DROP CONSTRAINT revocation_journal_kind_check;
ALTER TABLE pactaris.revocation_journal ADD CONSTRAINT revocation_journal_kind_check CHECK(kind IN ('membership.ended','member.paused',
 'household.stopped','relationship.paused','relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked',
 'document.deleted','attachment.deleted','checkin.withdrawn','account.erased','exchange.withdrawn','authority.ended','delegation.revoked','primary.released','habit.break'));
CREATE FUNCTION pactaris.journal_habit_break() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF jsonb_array_length(NEW.breaks)>jsonb_array_length(OLD.breaks) THEN
  PERFORM pactaris.journal_record(NEW.household_id,'habit.break',jsonb_build_object('habitId',NEW.id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.journal_habit_break() FROM PUBLIC;
CREATE TRIGGER journal_habit_break AFTER UPDATE OF breaks ON pactaris.authority_habits FOR EACH ROW EXECUTE FUNCTION pactaris.journal_habit_break();

CREATE OR REPLACE FUNCTION pactaris.journal_apply(target uuid,entry_kind text,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE p pactaris.assignment_policies; doc uuid; home uuid;
BEGIN
 IF entry_kind='account.erased' THEN
  SELECT instance_id INTO home FROM pactaris.households WHERE id=target;
  PERFORM pactaris.account_erasure(home,(s->>'accountId')::uuid,'forced');
  RETURN;
 END IF;
 IF entry_kind='membership.ended' THEN
  IF s->>'status' NOT IN ('left','revoked') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid'; END IF;
  UPDATE pactaris.memberships SET status=s->>'status'
   WHERE household_id=target AND id=(s->>'membershipId')::uuid AND status NOT IN ('left','revoked');
 ELSIF entry_kind='member.paused' THEN
  UPDATE pactaris.memberships SET safety_paused=true,safety_epoch=safety_epoch+1
   WHERE household_id=target AND id=(s->>'membershipId')::uuid AND NOT safety_paused;
 ELSIF entry_kind='household.stopped' THEN
  IF s->>'status'='closed' THEN
   UPDATE pactaris.households SET status='closed' WHERE id=target AND status<>'closed';
  ELSE
   UPDATE pactaris.households SET status='paused',safety_version=safety_version+1 WHERE id=target AND status='active';
  END IF;
 ELSIF entry_kind='relationship.paused' THEN
  IF EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target
     AND relationship_id=(s->>'relationshipId')::uuid AND membership_id=(s->>'membershipId')::uuid) THEN
   INSERT INTO pactaris.relationship_holds(household_id,relationship_id,membership_id,paused,epoch)
    VALUES(target,(s->>'relationshipId')::uuid,(s->>'membershipId')::uuid,true,2)
    ON CONFLICT(household_id,relationship_id,membership_id) DO UPDATE SET paused=true,epoch=pactaris.relationship_holds.epoch+1
    WHERE NOT pactaris.relationship_holds.paused;
  END IF;
 ELSIF entry_kind='relationship.ended' THEN
  UPDATE pactaris.relationships SET status='ended',ended_at=coalesce(ended_at,statement_timestamp()),
   end_reason=CASE WHEN s->>'reason' IN ('declined','withdrawn','membershipEnded') THEN s->>'reason' ELSE 'withdrawn' END
   WHERE household_id=target AND id=(s->>'relationshipId')::uuid AND status<>'ended';
 ELSIF entry_kind='agreement.revoked' THEN
  UPDATE pactaris.agreement_versions SET revoked=true
   WHERE household_id=target AND agreement_id=(s->>'agreementId')::uuid AND version=(s->>'version')::bigint AND NOT revoked;
 ELSIF entry_kind='consent.withdrawn' THEN
  IF s->>'decision' NOT IN ('declined','withdrawn') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid'; END IF;
  UPDATE pactaris.agreement_decisions SET decision=s->>'decision',decided_at=coalesce(decided_at,statement_timestamp())
   WHERE household_id=target AND agreement_id=(s->>'agreementId')::uuid AND version=(s->>'version')::bigint
    AND membership_id=(s->>'membershipId')::uuid AND decision NOT IN ('declined','withdrawn');
 ELSIF entry_kind='taskAuthority.revoked' THEN
  FOR p IN UPDATE pactaris.assignment_policies SET state='revoked',version=version+1
   WHERE household_id=target AND id=(s->>'policyId')::uuid AND state<>'revoked' RETURNING * LOOP
   INSERT INTO pactaris.assignment_policy_events VALUES(p.household_id,p.id,p.version,'restoreReplay',p.creator_id,statement_timestamp());
  END LOOP;
 ELSIF entry_kind='document.deleted' THEN
  doc=(s->>'documentId')::uuid;
  IF EXISTS(SELECT 1 FROM pactaris.documents WHERE household_id=target AND id=doc AND state<>'deleted') THEN
   DELETE FROM pactaris.document_assignments WHERE household_id=target AND document_id=doc;
   DELETE FROM pactaris.document_acknowledgements WHERE household_id=target AND document_id=doc;
   DELETE FROM pactaris.document_versions WHERE household_id=target AND document_id=doc;
   UPDATE pactaris.documents SET state='deleted',version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=doc;
  END IF;
 ELSIF entry_kind='attachment.deleted' THEN
  DELETE FROM pactaris.draft_attachments WHERE household_id=target AND document_id=(s->>'documentId')::uuid;
 ELSIF entry_kind='checkin.withdrawn' THEN
  UPDATE pactaris.shared_checkins SET state='withdrawn',response=NULL,title=id::text,version=version+1
   WHERE household_id=target AND id=(s->>'checkinId')::uuid AND state<>'withdrawn';
 ELSIF entry_kind='exchange.withdrawn' THEN
  UPDATE pactaris.exchanges SET state='withdrawn',title='',body='',response=NULL,due_at=NULL,version=version+1
   WHERE household_id=target AND id=(s->>'exchangeId')::uuid AND state<>'withdrawn';
 ELSIF entry_kind='authority.ended' THEN
  UPDATE pactaris.authority_links SET state='ended',ended_at=coalesce(ended_at,statement_timestamp()),version=version+1
   WHERE household_id=target AND id=(s->>'linkId')::uuid AND state<>'ended';
  PERFORM pactaris.authority_sync(target);
 ELSIF entry_kind='delegation.revoked' THEN
  UPDATE pactaris.authority_delegations SET state='revoked',version=version+1
   WHERE household_id=target AND id=(s->>'delegationId')::uuid AND state<>'revoked';
  PERFORM pactaris.authority_sync(target);
 ELSIF entry_kind='habit.break' THEN
  UPDATE pactaris.authority_habits SET state='paused',version=version+1,skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=target AND id=(s->>'habitId')::uuid AND state='active';
 ELSIF entry_kind='primary.released' THEN
  UPDATE pactaris.authority_links SET is_primary=false,legacy_full=false,version=version+1
   WHERE household_id=target AND id=(s->>'linkId')::uuid AND (is_primary OR legacy_full);
  PERFORM pactaris.authority_sync(target);
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;

