-- Additional scope-specific changes that affect currently permitted views.
CREATE FUNCTION pactaris.workspace_change_delivery_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h uuid;resource uuid;who uuid;
BEGIN
 IF TG_TABLE_NAME='assignment_policies' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.creator_id,OLD.creator_id),coalesce(NEW.assignee_id,OLD.assignee_id)]) ORDER BY 1 LOOP PERFORM pactaris.workspace_change_bump(h,who,'tasks'); END LOOP;
 ELSIF TG_TABLE_NAME='document_acknowledgements' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.document_id,OLD.document_id);
  FOR who IN SELECT DISTINCT id FROM (SELECT coalesce(NEW.membership_id,OLD.membership_id) AS id UNION ALL SELECT creator_membership_id FROM pactaris.documents WHERE household_id=h AND pactaris.documents.id=resource) people WHERE id IS NOT NULL ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(h,who,'library'); END LOOP;
 ELSIF TG_TABLE_NAME='relationship_holds' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.relationship_id,OLD.relationship_id);
  FOR who IN SELECT membership_id FROM pactaris.relationship_participants WHERE household_id=h AND relationship_id=resource AND decision='accepted' ORDER BY membership_id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='agreement_decisions' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.agreement_id,OLD.agreement_id);
  FOR who IN SELECT rp.membership_id FROM pactaris.agreements a JOIN pactaris.relationship_participants rp ON rp.household_id=a.household_id AND rp.relationship_id=a.relationship_id WHERE a.household_id=h AND a.id=resource AND (rp.decision='accepted' OR rp.membership_id=coalesce(NEW.membership_id,OLD.membership_id)) ORDER BY rp.membership_id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='household_terms' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT id FROM pactaris.memberships WHERE household_id=h AND status='active' ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME='shop_listings' THEN
  h=coalesce(NEW.household_id,OLD.household_id);resource=coalesce(NEW.holder_id,OLD.holder_id);
  FOR who IN SELECT id FROM pactaris.memberships WHERE household_id=h AND status='active' AND (id=resource OR pactaris.authority_area(h,resource,id,'outcomes')) ORDER BY id LOOP PERFORM pactaris.workspace_change_bump(h,who,'dynamic'); END LOOP;
 ELSIF TG_TABLE_NAME IN ('notice_preferences','task_delivery_preferences') THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.member_id,OLD.member_id),'notices');
 ELSIF TG_TABLE_NAME='task_inbox_preferences' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.membership_id,OLD.membership_id),'notices');
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_delivery_event() FROM PUBLIC;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['assignment_policies','document_acknowledgements','relationship_holds','agreement_decisions','household_terms','shop_listings','notice_preferences','task_delivery_preferences','task_inbox_preferences'] LOOP
  EXECUTE format('CREATE TRIGGER workspace_change_delivery_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.%I FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_delivery_event()',n);
 END LOOP;
END $$;
