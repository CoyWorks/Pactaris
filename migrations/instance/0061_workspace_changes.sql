-- Commit-safe, content-free invalidations for the active household and exact membership.
-- A token row is locked until the modifying transaction commits; concurrent writers of the
-- same topic cannot commit out of order and lose a change. Cursors never authorize a read.
CREATE TABLE pactaris.workspace_change_tokens (
 household_id uuid NOT NULL,member_id uuid NOT NULL,topic text NOT NULL CHECK(topic IN ('workspace','tasks','notices')),
 token uuid NOT NULL DEFAULT gen_random_uuid(),PRIMARY KEY(household_id,member_id,topic),
 FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.workspace_change_cursors (
 household_id uuid NOT NULL,member_id uuid NOT NULL,id uuid NOT NULL,tokens jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,member_id,id),FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['workspace_change_tokens','workspace_change_cursors'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',n);
 END LOOP;
END $$;
CREATE FUNCTION pactaris.workspace_change_bump(target uuid,member uuid,kind text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.workspace_change_tokens(household_id,member_id,topic,token)
 SELECT target,member,kind,gen_random_uuid() WHERE EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=member AND status='active' AND account_erased_at IS NULL)
 ON CONFLICT(household_id,member_id,topic) DO UPDATE SET token=EXCLUDED.token
$$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_bump(uuid,uuid,text) FROM PUBLIC;
CREATE FUNCTION pactaris.workspace_change_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h uuid; who uuid;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  h=coalesce(NEW.household_id,OLD.household_id);who=coalesce(NEW.creator_membership_id,OLD.creator_membership_id);
  PERFORM pactaris.workspace_change_bump(h,who,'workspace');
 ELSIF TG_TABLE_NAME='partner_tasks' THEN
  h=coalesce(NEW.household_id,OLD.household_id);
  FOR who IN SELECT DISTINCT unnest(ARRAY[coalesce(NEW.creator_id,OLD.creator_id),coalesce(NEW.assignee_id,OLD.assignee_id)]) ORDER BY 1 LOOP
   PERFORM pactaris.workspace_change_bump(h,who,'tasks');
  END LOOP;
 ELSIF TG_TABLE_NAME='task_approvals' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.approver_id,OLD.approver_id),'tasks');
 ELSIF TG_TABLE_NAME='member_notices' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.recipient_id,OLD.recipient_id),'notices');
 ELSIF TG_TABLE_NAME='task_inbox' THEN
  PERFORM pactaris.workspace_change_bump(coalesce(NEW.household_id,OLD.household_id),coalesce(NEW.recipient,OLD.recipient),'notices');
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_event() FROM PUBLIC;
CREATE TRIGGER workspace_change_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.tasks FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_event();
CREATE TRIGGER workspace_change_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.partner_tasks FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_event();
CREATE TRIGGER workspace_change_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.task_approvals FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_event();
CREATE TRIGGER workspace_change_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.member_notices FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_event();
CREATE TRIGGER workspace_change_event AFTER INSERT OR UPDATE OR DELETE ON pactaris.task_inbox FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_event();
CREATE FUNCTION pactaris.workspace_change_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF (OLD.status='active' AND NEW.status<>'active') OR (OLD.account_erased_at IS NULL AND NEW.account_erased_at IS NOT NULL) THEN
  DELETE FROM pactaris.workspace_change_cursors WHERE household_id=NEW.household_id AND member_id=NEW.id;
  DELETE FROM pactaris.workspace_change_tokens WHERE household_id=NEW.household_id AND member_id=NEW.id;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_cleanup() FROM PUBLIC;
CREATE TRIGGER workspace_change_cleanup AFTER UPDATE OF status,account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.workspace_change_cleanup();
CREATE FUNCTION pactaris.workspace_change_check(target uuid,instance uuid,actor uuid,member uuid,cursor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE current_tokens jsonb;previous jsonb;changes jsonb;new_cursor uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id WHERE m.household_id=target AND m.id=member AND m.account_id=actor AND m.status='active' AND h.instance_id=instance AND h.status<>'closed') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF cursor IS NOT NULL THEN
  SELECT tokens INTO previous FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member AND id=cursor AND created_at>now()-interval '24 hours';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
 END IF;
 SELECT coalesce(jsonb_object_agg(topic,token::text),'{}'::jsonb) INTO current_tokens FROM pactaris.workspace_change_tokens WHERE household_id=target AND member_id=member;
 SELECT coalesce(jsonb_agg(topic ORDER BY topic),'[]'::jsonb) INTO changes FROM (SELECT topic FROM unnest(ARRAY['workspace','tasks','notices']) topic WHERE previous IS NULL OR previous->>topic IS DISTINCT FROM current_tokens->>topic) q;
 IF previous IS NOT NULL AND jsonb_array_length(changes)=0 THEN RETURN jsonb_build_object('cursor',cursor,'changed',changes); END IF;
 new_cursor=gen_random_uuid();INSERT INTO pactaris.workspace_change_cursors(household_id,member_id,id,tokens) VALUES(target,member,new_cursor,current_tokens);
 DELETE FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member AND (created_at<now()-interval '24 hours' OR id IN (SELECT id FROM pactaris.workspace_change_cursors WHERE household_id=target AND member_id=member ORDER BY created_at DESC,id DESC OFFSET 64));
 RETURN jsonb_build_object('cursor',new_cursor,'changed',changes);
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_change_check(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

-- Include the bounded technical cursor records in personal export.
CREATE OR REPLACE FUNCTION pactaris.authority_export_page(instance uuid,account uuid,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; rows jsonb; last text;
BEGIN
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
  SELECT k,row FROM (
   SELECT c.household_id::text||':'||c.member_id::text||':change:'||c.topic AS k,jsonb_build_object('kind','workspaceChangeToken')||to_jsonb(c) AS row FROM pactaris.workspace_change_tokens c WHERE c.member_id=ANY(members)
   UNION ALL
   SELECT c.household_id::text||':'||c.member_id::text||':cursor:'||c.id::text,jsonb_build_object('kind','workspaceChangeCursor')||to_jsonb(c) FROM pactaris.workspace_change_cursors c WHERE c.member_id=ANY(members)
   UNION ALL
   SELECT p.household_id::text||':'||p.member_id::text||':noticePreferences' AS k,jsonb_build_object('kind','noticePreferences')||to_jsonb(p) AS row FROM pactaris.notice_preferences p WHERE p.member_id=ANY(members)
   UNION ALL
   SELECT x.household_id::text||':'||x.id::text AS k,jsonb_build_object('kind','link')||to_jsonb(x) AS row FROM pactaris.authority_links x WHERE x.dom_id=ANY(members) OR x.sub_id=ANY(members)
   UNION ALL
   SELECT d.household_id::text||':'||d.id::text,jsonb_build_object('kind','delegation')||to_jsonb(d) FROM pactaris.authority_delegations d
    JOIN pactaris.authority_links l ON l.household_id=d.household_id AND l.id=d.link_id WHERE d.delegate_id=ANY(members) OR l.dom_id=ANY(members) OR l.sub_id=ANY(members)
   UNION ALL
   SELECT a.household_id::text||':'||a.id::text,jsonb_build_object('kind','pointAdjustment')||to_jsonb(a) FROM pactaris.point_adjustments a WHERE a.recipient_id=ANY(members) OR a.issuer_id=ANY(members)
   UNION ALL
   SELECT b.household_id::text||':'||b.id::text,jsonb_build_object('kind','habit')||to_jsonb(b)||jsonb_build_object('entries',
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at),'[]'::jsonb) FROM pactaris.authority_habit_entries e WHERE e.household_id=b.household_id AND e.habit_id=b.id),
    'results',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.period_start),'[]'::jsonb) FROM pactaris.authority_habit_results r WHERE r.household_id=b.household_id AND r.habit_id=b.id))
    FROM pactaris.authority_habits b WHERE b.holder_id=ANY(members) OR b.subject_id=ANY(members)
   UNION ALL
   SELECT t.household_id::text||':'||t.id::text,jsonb_build_object('kind','primaryTransfer')||to_jsonb(t) FROM pactaris.authority_transfers t
    WHERE t.sub_id=ANY(members) OR t.to_dom=ANY(members) OR t.proposer_id=ANY(members) OR t.from_dom=ANY(members)
  ) all_rows WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','authority','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
