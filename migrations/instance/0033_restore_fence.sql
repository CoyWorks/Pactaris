-- A restored database starts fenced. While fenced, the Instance serves no household
-- reads or commands and its worker runs no jobs. The gateway replays every journal
-- entry the snapshot does not contain, then releases the fence.
CREATE TABLE pactaris.restore_fence (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 fenced boolean NOT NULL DEFAULT false,
 fenced_at timestamptz,
 released_at timestamptz
);
INSERT INTO pactaris.restore_fence DEFAULT VALUES;
ALTER TABLE pactaris.restore_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.restore_fence FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_fence_command ON pactaris.restore_fence FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.restore_fenced() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT coalesce((SELECT fenced FROM pactaris.restore_fence),true);
$$;
REVOKE ALL ON FUNCTION pactaris.restore_fenced() FROM PUBLIC;

-- Apply one entry idempotently. Every action only moves state towards ended, paused,
-- revoked or deleted; nothing is resumed, re-accepted or restored.
CREATE FUNCTION pactaris.journal_apply(target uuid,entry_kind text,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE p pactaris.assignment_policies; doc uuid;
BEGIN
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
  IF EXISTS(SELECT 1 FROM pactaris.documents WHERE household_id=target AND id=doc AND kind='note' AND state<>'deleted') THEN
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
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;
REVOKE ALL ON FUNCTION pactaris.journal_apply(uuid,text,jsonb) FROM PUBLIC;

-- Gateway-driven replay of its central copy. Entries the snapshot already contains are
-- skipped; entries for households that do not exist in the snapshot cannot apply.
CREATE FUNCTION pactaris.revocation_journal_replay(instance uuid,entries jsonb,final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE e jsonb; target uuid; entry uuid; applied integer:=0; skipped integer:=0;
BEGIN
 IF instance IS NULL OR final IS NULL OR jsonb_typeof(entries)<>'array' OR jsonb_array_length(entries)>50 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
 PERFORM 1 FROM pactaris.restore_fence FOR UPDATE;
 IF NOT pactaris.restore_fenced() THEN
  RETURN jsonb_build_object('fenced',false,'applied',0,'skipped',jsonb_array_length(entries),'released',false);
 END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
  entry=(e->>'id')::uuid;target=(e->>'householdId')::uuid;
  IF EXISTS(SELECT 1 FROM pactaris.revocation_journal WHERE id=entry)
     OR NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
   skipped=skipped+1;CONTINUE;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
  PERFORM pactaris.journal_apply(target,e->>'kind',e->'subject');
  -- Keep the original entry so a later replay of the same copy is a no-op.
  INSERT INTO pactaris.revocation_journal(id,household_id,kind,subject,occurred_at,exported_at)
   VALUES(entry,target,e->>'kind',e->'subject',(e->>'occurredAt')::timestamptz,statement_timestamp());
  applied=applied+1;
 END LOOP;
 IF final THEN
  -- Short-lived restrictive grants from before the backup are not carried over.
  DELETE FROM pactaris.local_safety_grants;
  UPDATE pactaris.restore_fence SET fenced=false,released_at=statement_timestamp();
 END IF;
 RETURN jsonb_build_object('fenced',true,'applied',applied,'skipped',skipped,'released',final);
END $$;
REVOKE ALL ON FUNCTION pactaris.revocation_journal_replay(uuid,jsonb,boolean) FROM PUBLIC;

-- The pending export now also reports the fence, so the gateway knows to replay.
CREATE OR REPLACE FUNCTION pactaris.revocation_journal_pending(instance uuid,max_entries integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF instance IS NULL OR max_entries IS NULL OR max_entries NOT BETWEEN 1 AND 50 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
 RETURN jsonb_build_object('fenced',pactaris.restore_fenced(),'entries',coalesce((
  SELECT jsonb_agg(jsonb_build_object('id',e.id,'householdId',e.household_id,'kind',e.kind,'subject',e.subject,
    'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY e.occurred_at,e.id)
  FROM (SELECT j.* FROM pactaris.revocation_journal j JOIN pactaris.households h ON h.id=j.household_id
   WHERE j.exported_at IS NULL AND h.instance_id=instance ORDER BY j.occurred_at,j.id LIMIT max_entries) e),'[]'::jsonb));
END $$;
