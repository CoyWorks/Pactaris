-- Account-wide erasure on this Instance (docs/ACCOUNT_DELETION.md). Personal-private
-- content of every membership of the account is removed. Shared records remain for
-- the other participants, but the text this person wrote is blanked and the
-- membership is shown as a deleted account.
ALTER TABLE pactaris.memberships ADD COLUMN account_erased_at timestamptz;

ALTER TABLE pactaris.revocation_journal DROP CONSTRAINT revocation_journal_kind_check;
ALTER TABLE pactaris.revocation_journal ADD CONSTRAINT revocation_journal_kind_check CHECK(kind IN ('membership.ended','member.paused',
 'household.stopped','relationship.paused','relationship.ended','agreement.revoked','consent.withdrawn','taskAuthority.revoked',
 'document.deleted','attachment.deleted','checkin.withdrawn','account.erased'));

-- Blank user-authored strings anywhere in a JSON document, keeping its structure,
-- enumerations, numbers, dates and identifiers intact.
CREATE FUNCTION pactaris.erase_text(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE result jsonb; k text; v jsonb;
BEGIN
 IF j IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(j)='array' THEN
  RETURN coalesce((SELECT jsonb_agg(pactaris.erase_text(e) ORDER BY n) FROM jsonb_array_elements(j) WITH ORDINALITY x(e,n)),'[]'::jsonb);
 END IF;
 IF jsonb_typeof(j)<>'object' THEN RETURN j; END IF;
 result='{}'::jsonb;
 FOR k,v IN SELECT key,value FROM jsonb_each(j) LOOP
  IF jsonb_typeof(v)='string' AND k IN ('title','description','category','body','label','scope','hard','soft','signal',
     'aftercare','note','response','text','prompt','name','submission','feedback','question') THEN
   result=result||jsonb_build_object(k,'');
  ELSE
   result=result||jsonb_build_object(k,pactaris.erase_text(v));
  END IF;
 END LOOP;
 RETURN result;
END $$;

-- Owners who would leave other active members without any owner must transfer first.
CREATE FUNCTION pactaris.account_erasure_blocked(instance uuid,account uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT coalesce(jsonb_agg(m.household_id ORDER BY m.household_id),'[]'::jsonb)
 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
 WHERE h.instance_id=instance AND h.status<>'closed' AND m.account_id=account AND m.status='active' AND m.technical_role='owner'
  AND EXISTS(SELECT 1 FROM pactaris.memberships o WHERE o.household_id=m.household_id AND o.status='active' AND o.id<>m.id)
  AND NOT EXISTS(SELECT 1 FROM pactaris.memberships o WHERE o.household_id=m.household_id AND o.status='active' AND o.id<>m.id AND o.technical_role='owner');
$$;
REVOKE ALL ON FUNCTION pactaris.account_erasure_blocked(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.account_erase_content(target uuid,account uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; doc uuid;
BEGIN
 SELECT array_agg(id) INTO members FROM pactaris.memberships WHERE household_id=target AND account_id=account;
 IF members IS NULL THEN RETURN 0; END IF;
 UPDATE pactaris.memberships SET account_erased_at=coalesce(account_erased_at,statement_timestamp()),display_name=''
  WHERE household_id=target AND id=ANY(members);
 -- Personal-private content.
 UPDATE pactaris.personal_limits SET limits='{"hard":"","soft":"","signal":"","aftercare":"","blockedActivities":[]}'::jsonb,version=version+1
  WHERE household_id=target AND membership_id=ANY(members) AND limits<>'{"hard":"","soft":"","signal":"","aftercare":"","blockedActivities":[]}'::jsonb;
 DELETE FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=ANY(members);
 UPDATE pactaris.personal_task_series SET fields=pactaris.erase_text(fields) WHERE household_id=target AND creator_id=ANY(members);
 FOR doc IN SELECT id FROM pactaris.documents WHERE household_id=target AND creator_membership_id=ANY(members) AND state<>'deleted' LOOP
  DELETE FROM pactaris.document_assignments WHERE household_id=target AND document_id=doc;
  DELETE FROM pactaris.document_acknowledgements WHERE household_id=target AND document_id=doc;
  DELETE FROM pactaris.document_versions WHERE household_id=target AND document_id=doc;
  UPDATE pactaris.documents SET state='deleted',version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=doc;
 END LOOP;
 UPDATE pactaris.routine_revisions r SET fields=pactaris.erase_text(r.fields) FROM pactaris.routines o
  WHERE r.household_id=target AND o.household_id=target AND o.id=r.routine_id AND o.creator_membership_id=ANY(members);
 UPDATE pactaris.progress_events e SET text='' FROM pactaris.routines o
  WHERE e.household_id=target AND o.household_id=target AND o.id=e.routine_id AND o.creator_membership_id=ANY(members) AND e.text<>'';
 UPDATE pactaris.catalog_versions v SET fields=pactaris.erase_text(v.fields) FROM pactaris.catalog_items i
  WHERE v.household_id=target AND i.household_id=target AND i.id=v.item_id AND i.creator_membership_id=ANY(members);
 UPDATE pactaris.shared_checkins SET state='withdrawn',response=NULL,title=id::text,version=version+1
  WHERE household_id=target AND author_id=ANY(members) AND state<>'withdrawn';
 DELETE FROM pactaris.task_delivery_preferences WHERE household_id=target AND member_id=ANY(members);
 DELETE FROM pactaris.local_safety_grants WHERE household_id=target AND membership_id=ANY(members);
 -- Shared records stay for the other participants; only this person's own text is blanked.
 UPDATE pactaris.partner_tasks SET fields=pactaris.erase_text(fields) WHERE household_id=target AND creator_id=ANY(members);
 UPDATE pactaris.partner_events SET note='' WHERE household_id=target AND actor_id=ANY(members) AND note<>'';
 UPDATE pactaris.task_series SET fields=pactaris.erase_text(fields) WHERE household_id=target AND creator_id=ANY(members);
 UPDATE pactaris.task_series_versions v SET definition=pactaris.erase_text(v.definition) FROM pactaris.task_series s
  WHERE v.household_id=target AND s.household_id=target AND s.id=v.series_id AND s.creator_id=ANY(members);
 UPDATE pactaris.agreement_versions SET terms=pactaris.erase_text(terms) WHERE household_id=target AND created_by=ANY(members);
 UPDATE pactaris.relationships SET label='',scope='' WHERE household_id=target AND proposer_membership_id=ANY(members);
 UPDATE pactaris.relationship_roles SET context='' WHERE household_id=target AND membership_id=ANY(members);
 UPDATE pactaris.reward_redemptions SET terms=pactaris.erase_text(terms) WHERE household_id=target AND issuer_id=ANY(members);
 RETURN cardinality(members);
END $$;
REVOKE ALL ON FUNCTION pactaris.account_erase_content(uuid,uuid) FROM PUBLIC;

-- check: report blockers only. erase: leave every active membership through the normal
-- departure command, then erase content in every household where the account was a member.
-- forced: replay after a restore; the original request already passed the owner check.
CREATE FUNCTION pactaris.account_erasure(instance uuid,account uuid,mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE blocked jsonb; m pactaris.memberships; target uuid; erased integer:=0; households integer:=0;
BEGIN
 IF instance IS NULL OR account IS NULL OR mode NOT IN ('check','erase','forced') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 blocked=CASE WHEN mode='forced' THEN '[]'::jsonb ELSE pactaris.account_erasure_blocked(instance,account) END;
 IF mode='check' OR jsonb_array_length(blocked)>0 THEN
  RETURN jsonb_build_object('blockedHouseholds',blocked,'erased',false,'memberships',0);
 END IF;
 FOR m IN SELECT ms.* FROM pactaris.memberships ms JOIN pactaris.households h ON h.id=ms.household_id
   WHERE h.instance_id=instance AND ms.account_id=account AND ms.status='active' ORDER BY ms.household_id LOOP
  PERFORM pactaris.leave_household_command(m.household_id,instance,account,gen_random_uuid(),encode(sha256(convert_to('account.erase:'||m.id::text,'UTF8')),'hex'),m.id);
 END LOOP;
 FOR target IN SELECT DISTINCT ms.household_id FROM pactaris.memberships ms JOIN pactaris.households h ON h.id=ms.household_id
   WHERE h.instance_id=instance AND ms.account_id=account ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
  erased=erased+pactaris.account_erase_content(target,account);households=households+1;
  IF mode<>'forced' THEN
   PERFORM pactaris.journal_record(target,'account.erased',jsonb_build_object('accountId',account));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('blockedHouseholds','[]'::jsonb,'erased',true,'memberships',erased);
END $$;
REVOKE ALL ON FUNCTION pactaris.account_erasure(uuid,uuid,text) FROM PUBLIC;

-- Replay erases again after a restore, so blanked text cannot return from a backup.
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
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='journal.invalid';
 END IF;
END $$;
