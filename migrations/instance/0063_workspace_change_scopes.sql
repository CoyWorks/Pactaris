-- Expand scoped invalidations to additional resources already visible to each recipient.
ALTER TABLE pactaris.workspace_change_tokens DROP CONSTRAINT workspace_change_tokens_topic_check;
ALTER TABLE pactaris.workspace_change_tokens ADD CONSTRAINT workspace_change_tokens_topic_check CHECK(topic IN ('workspace','tasks','notices','routines','library','dynamic','catalog'));
CREATE FUNCTION pactaris.workspace_change_habit(target uuid,habit uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE x pactaris.authority_habits; who uuid;
BEGIN
 SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=habit;
 IF NOT FOUND THEN RETURN; END IF;
 FOR who IN SELECT id FROM pactaris.memberships WHERE household_id=target AND status='active'
  AND (id IN (x.holder_id,x.subject_id) OR pactaris.authority_area(target,id,x.subject_id,'tasks')) ORDER BY id LOOP
  PERFORM pactaris.workspace_change_bump(target,who,'dynamic');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_habit(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION pactaris.workspace_change_more() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h uuid; resource uuid; who uuid;
BEGIN
 IF TG_TABLE_NAME='routines' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.creator_membership_id,OLD.creator_membership_id),'routines');
 ELSIF TG_TABLE_NAME='progress_events' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.routine_id,OLD.routine_id);
  SELECT creator_membership_id INTO who FROM pactaris.routines WHERE household_id=h AND pactaris.routines.id=resource;
  IF who IS NOT NULL THEN PERFORM pactaris.workspace_change_bump(h,who,'routines'); END IF;
 ELSIF TG_TABLE_NAME='catalog_items' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.creator_membership_id,OLD.creator_membership_id),'catalog');
 ELSIF TG_TABLE_NAME='personal_task_series' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.creator_id,OLD.creator_id),'workspace');
 ELSIF TG_TABLE_NAME='shared_checkins' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.author_id,OLD.author_id),coalesce(NEW.reviewer_id,OLD.reviewer_id)]) ORDER BY 1 LOOP
   IF who IS NOT NULL THEN PERFORM pactaris.workspace_change_bump(h,who,'routines'); END IF;
  END LOOP;
 ELSIF TG_TABLE_NAME='documents' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.id,OLD.id);
  -- Include recipients of the previous revision, so revoked visibility clears stale screens.
  FOR who IN SELECT m.id FROM pactaris.memberships m WHERE m.household_id=h AND m.status='active' AND
   (m.id=coalesce(NEW.creator_membership_id,OLD.creator_membership_id) OR pactaris.document_visible(h,resource,m.id)
    OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM pactaris.document_versions v WHERE v.household_id=h AND v.document_id=resource AND v.version=OLD.version AND v.state='published' AND (v.visibility='household' OR (v.visibility='participants' AND v.recipients?m.id::text))))) ORDER BY m.id LOOP
   PERFORM pactaris.workspace_change_bump(h,who,'library');
  END LOOP;
 ELSIF TG_TABLE_NAME='document_assignments' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.document_id,OLD.document_id);
  PERFORM pactaris.workspace_change_bump(h,coalesce(NEW.recipient_id,OLD.recipient_id),'library');
  SELECT creator_membership_id INTO who FROM pactaris.documents WHERE household_id=h AND pactaris.documents.id=resource;
  IF who IS NOT NULL THEN PERFORM pactaris.workspace_change_bump(h,who,'library'); END IF;
 ELSIF TG_TABLE_NAME='document_versions' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.document_id,OLD.document_id);
  FOR who IN SELECT m.id FROM pactaris.memberships m JOIN pactaris.documents d ON d.household_id=m.household_id AND d.id=resource
   WHERE m.household_id=h AND m.status='active' AND (m.id=d.creator_membership_id OR
    (coalesce(NEW.state,OLD.state)='published' AND (coalesce(NEW.visibility,OLD.visibility)='household' OR (coalesce(NEW.visibility,OLD.visibility)='participants' AND coalesce(NEW.recipients,OLD.recipients)?m.id::text)))) ORDER BY m.id LOOP
   PERFORM pactaris.workspace_change_bump(h,who,'library');
  END LOOP;
 ELSIF TG_TABLE_NAME='task_series' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.creator_id,OLD.creator_id),coalesce(NEW.assignee_id,OLD.assignee_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'tasks'); END LOOP;
 ELSIF TG_TABLE_NAME='authority_habits' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.id,OLD.id);
  IF TG_OP='DELETE' THEN
   FOR who IN SELECT id FROM pactaris.memberships WHERE household_id=h AND status='active' AND (id IN (OLD.holder_id,OLD.subject_id) OR pactaris.authority_area(h,id,OLD.subject_id,'tasks')) ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
  ELSE PERFORM pactaris.workspace_change_habit(h,resource); END IF;
 ELSIF TG_TABLE_NAME IN ('authority_habit_entries','authority_habit_results') THEN
  PERFORM pactaris.workspace_change_habit(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.habit_id,OLD.habit_id));
 ELSIF TG_TABLE_NAME='exchanges' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  IF pactaris.exchange_allowed(h,coalesce(NEW.kind,OLD.kind),coalesce(NEW.author_id,OLD.author_id),coalesce(NEW.recipient_id,OLD.recipient_id)) THEN
   FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.author_id,OLD.author_id),coalesce(NEW.recipient_id,OLD.recipient_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='authority_links' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.dom_id,OLD.dom_id),coalesce(NEW.sub_id,OLD.sub_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='authority_delegations' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.link_id,OLD.link_id);
  FOR who IN SELECT DISTINCT id FROM (SELECT unnest(ARRAY[coalesce(NEW.delegate_id,OLD.delegate_id),coalesce(NEW.created_by,OLD.created_by)]) AS id UNION ALL SELECT dom_id FROM pactaris.authority_links WHERE household_id=h AND pactaris.authority_links.id=resource UNION ALL SELECT sub_id FROM pactaris.authority_links WHERE household_id=h AND pactaris.authority_links.id=resource) recipients WHERE id IS NOT NULL ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='authority_transfers' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.sub_id,OLD.sub_id),coalesce(NEW.from_dom,OLD.from_dom),coalesce(NEW.to_dom,OLD.to_dom),coalesce(NEW.proposer_id,OLD.proposer_id)]) ORDER BY 1 LOOP IF who IS NOT NULL THEN PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END IF; END LOOP;
 ELSIF TG_TABLE_NAME='relationship_participants' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.membership_id,OLD.membership_id),'dynamic');
 ELSIF TG_TABLE_NAME='relationships' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.id,OLD.id);
  FOR who IN SELECT membership_id FROM pactaris.relationship_participants WHERE household_id=h AND relationship_id=resource AND decision='accepted' ORDER BY membership_id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='agreements' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.relationship_id,OLD.relationship_id);
  FOR who IN SELECT membership_id FROM pactaris.relationship_participants WHERE household_id=h AND relationship_id=resource AND decision='accepted' ORDER BY membership_id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='agreement_versions' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.agreement_id,OLD.agreement_id);
  FOR who IN SELECT rp.membership_id FROM pactaris.agreements a JOIN pactaris.relationship_participants rp ON rp.household_id=a.household_id AND rp.relationship_id=a.relationship_id WHERE a.household_id=h AND a.id=resource AND rp.decision='accepted' ORDER BY rp.membership_id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='personal_limits' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.membership_id,OLD.membership_id),'workspace');
 ELSIF TG_TABLE_NAME='households' THEN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.safety_version IS DISTINCT FROM NEW.safety_version OR OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.time_zone IS DISTINCT FROM NEW.time_zone THEN
   FOR who IN SELECT id FROM pactaris.memberships WHERE household_id=NEW.id AND status='active' ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(NEW.id,who,'workspace'); END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='memberships' THEN
  IF OLD.safety_paused IS DISTINCT FROM NEW.safety_paused THEN PERFORM pactaris.workspace_change_bump(NEW.household_id,NEW.id,'workspace'); END IF;
 ELSIF TG_TABLE_NAME='point_adjustments' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.issuer_id,OLD.issuer_id),coalesce(NEW.recipient_id,OLD.recipient_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='reward_redemptions' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.issuer_id,OLD.issuer_id),coalesce(NEW.recipient_id,OLD.recipient_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_more() FROM PUBLIC;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['routines','progress_events','catalog_items','personal_task_series','shared_checkins','documents','document_assignments','document_versions','task_series','authority_habits','authority_habit_entries','authority_habit_results','exchanges','authority_links','authority_delegations','authority_transfers','relationships','relationship_participants','agreements','agreement_versions','personal_limits','point_adjustments','reward_redemptions'] LOOP
  EXECUTE format('CREATE TRIGGER workspace_change_more AFTER INSERT OR UPDATE OR DELETE ON pactaris.%I FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_more()',n);
 END LOOP;
END $$;
CREATE TRIGGER workspace_change_more AFTER UPDATE OF status,safety_version,display_name,time_zone ON pactaris.households FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_more();
CREATE TRIGGER workspace_change_more AFTER UPDATE OF safety_paused ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_more();

CREATE OR REPLACE FUNCTION pactaris.workspace_change_check(target uuid,instance uuid,actor uuid,member uuid,cursor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE current_tokens jsonb;previous jsonb;changes jsonb;new_cursor uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id WHERE m.household_id=target AND m.id=member AND m.account_id=actor AND m.status='active' AND h.instance_id=instance AND h.status<>'closed') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF cursor IS NOT NULL THEN
  SELECT tokens INTO previous FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member AND id=cursor AND created_at>now()-interval '24 hours';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
 END IF;
 SELECT coalesce(jsonb_object_agg(topic,token::text),'{}'::jsonb) INTO current_tokens FROM pactaris.workspace_change_tokens WHERE household_id=target AND member_id=member;
 SELECT coalesce(jsonb_agg(topic ORDER BY topic),'[]'::jsonb) INTO changes FROM (SELECT topic FROM unnest(ARRAY['workspace','tasks','notices','routines','library','dynamic','catalog']) topic WHERE previous IS NULL OR previous->>topic IS DISTINCT FROM current_tokens->>topic) q;
 IF previous IS NOT NULL AND jsonb_array_length(changes)=0 THEN RETURN jsonb_build_object('cursor',cursor,'changed',changes); END IF;
 new_cursor=gen_random_uuid();INSERT INTO pactaris.workspace_change_cursors(household_id,member_id,id,tokens) VALUES(target,member,new_cursor,current_tokens);
 DELETE FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member AND (created_at<now()-interval '24 hours' OR id IN (SELECT id FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member ORDER BY created_at DESC,id DESC OFFSET 64));
 RETURN jsonb_build_object('cursor',new_cursor,'changed',changes);
END $$;
