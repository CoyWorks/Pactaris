-- In-app notices for exchanges, Dom links, delegation, points and habit results (docs/NOTIFICATIONS.md).
-- They share the task inbox push sequence, so the existing gateway push worker delivers one
-- generic, content-free push for either. Notices are created by triggers inside the same
-- transaction as the change; a notice never carries text, only its kind and resource.
CREATE TABLE pactaris.member_notices (
 household_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),recipient_id uuid NOT NULL,actor_id uuid,
 kind text NOT NULL CHECK(kind IN ('permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit')),
 resource_id uuid NOT NULL,push_seq bigint NOT NULL,read boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),pushed_eligible_since timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(household_id,id),CHECK(actor_id IS NULL OR actor_id<>recipient_id),
 FOREIGN KEY(household_id,recipient_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,actor_id) REFERENCES pactaris.memberships(household_id,id)
);
DO $$ BEGIN
 EXECUTE format('ALTER TABLE pactaris.member_notices ALTER COLUMN push_seq SET DEFAULT nextval(%L)',pg_get_serial_sequence('pactaris.task_inbox','push_seq'));
END $$;
CREATE INDEX member_notices_recipient ON pactaris.member_notices(household_id,recipient_id,push_seq DESC);
ALTER TABLE pactaris.member_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.member_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.member_notices FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.notice(target uuid,recipient uuid,actor uuid,notice_kind text,resource uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.member_notices(household_id,recipient_id,actor_id,kind,resource_id)
 SELECT target,recipient,actor,notice_kind,resource
 WHERE recipient IS DISTINCT FROM actor AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=recipient AND status='active')
$$;
REVOKE ALL ON FUNCTION pactaris.notice(uuid,uuid,uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.notice_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='exchanges' THEN
  IF TG_OP='INSERT' THEN PERFORM pactaris.notice(NEW.household_id,NEW.recipient_id,NEW.author_id,NEW.kind,NEW.id);
  ELSIF OLD.state='open' AND NEW.state IN ('approved','declined','acknowledged') THEN PERFORM pactaris.notice(NEW.household_id,NEW.author_id,NEW.recipient_id,'answered',NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='authority_links' THEN
  IF TG_OP='INSERT' THEN PERFORM pactaris.notice(NEW.household_id,NEW.sub_id,NEW.dom_id,'invited',NEW.id);
  ELSIF OLD.state='invited' AND NEW.state='active' THEN PERFORM pactaris.notice(NEW.household_id,NEW.dom_id,NEW.sub_id,'accepted',NEW.id);
  ELSIF OLD.state<>'ended' AND NEW.state='ended' AND NEW.ended_by IS NOT NULL THEN
   PERFORM pactaris.notice(NEW.household_id,CASE WHEN NEW.ended_by=NEW.dom_id THEN NEW.sub_id ELSE NEW.dom_id END,NEW.ended_by,'ended',NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='authority_delegations' THEN
  IF TG_OP='INSERT' THEN PERFORM pactaris.notice(NEW.household_id,NEW.delegate_id,NEW.created_by,'delegated',NEW.id); END IF;
 ELSIF TG_TABLE_NAME='point_adjustments' THEN
  PERFORM pactaris.notice(NEW.household_id,NEW.recipient_id,CASE WHEN TG_OP='INSERT' THEN NEW.issuer_id END,'points',NEW.id);
 ELSIF TG_TABLE_NAME='authority_habit_results' THEN
  IF NEW.result<>'skipped' THEN
   PERFORM pactaris.notice(NEW.household_id,(SELECT subject_id FROM pactaris.authority_habits WHERE household_id=NEW.household_id AND id=NEW.habit_id),NULL,'habit',NEW.habit_id);
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.notice_events() FROM PUBLIC;
CREATE TRIGGER notice_events AFTER INSERT OR UPDATE OF state ON pactaris.exchanges FOR EACH ROW EXECUTE FUNCTION pactaris.notice_events();
CREATE TRIGGER notice_events AFTER INSERT OR UPDATE OF state ON pactaris.authority_links FOR EACH ROW EXECUTE FUNCTION pactaris.notice_events();
CREATE TRIGGER notice_events AFTER INSERT ON pactaris.authority_delegations FOR EACH ROW EXECUTE FUNCTION pactaris.notice_events();
CREATE TRIGGER notice_events AFTER INSERT ON pactaris.point_adjustments FOR EACH ROW EXECUTE FUNCTION pactaris.notice_events();
CREATE TRIGGER notice_events AFTER INSERT ON pactaris.authority_habit_results FOR EACH ROW EXECUTE FUNCTION pactaris.notice_events();

-- A withdrawn exchange or an ended membership leaves no unread notice behind.
CREATE FUNCTION pactaris.notice_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 -- Nested on purpose: PL/pgSQL may evaluate both sides of AND, and each table has its own columns.
 IF TG_TABLE_NAME='exchanges' THEN
  IF NEW.state='withdrawn' THEN DELETE FROM pactaris.member_notices WHERE household_id=NEW.household_id AND resource_id=NEW.id; END IF;
 ELSIF TG_TABLE_NAME='memberships' THEN
  IF OLD.status='active' AND NEW.status<>'active' THEN DELETE FROM pactaris.member_notices WHERE household_id=NEW.household_id AND recipient_id=NEW.id; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.notice_cleanup() FROM PUBLIC;
CREATE TRIGGER notice_cleanup AFTER UPDATE OF state ON pactaris.exchanges FOR EACH ROW EXECUTE FUNCTION pactaris.notice_cleanup();
CREATE TRIGGER notice_cleanup AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.notice_cleanup();

CREATE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;
BEGIN
 IF action IS NULL OR action NOT IN ('noticeList','noticeRead') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',a.display_name,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id ORDER BY push_seq DESC LIMIT 30) n
  LEFT JOIN pactaris.memberships a ON a.household_id=n.household_id AND a.id=n.actor_id;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread);
END $$;
REVOKE ALL ON FUNCTION pactaris.notice_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Erasure and export.
CREATE FUNCTION pactaris.notice_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.account_erased_at IS NOT NULL THEN DELETE FROM pactaris.member_notices WHERE household_id=NEW.household_id AND recipient_id=NEW.id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.notice_erasure() FROM PUBLIC;
CREATE TRIGGER notice_erasure AFTER UPDATE OF account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.notice_erasure();

-- Identical to 0028 apart from member notices taking part in the push sequence.
CREATE OR REPLACE FUNCTION pactaris.task_delivery_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; pref pactaris.task_delivery_preferences;
 response jsonb; settings jsonb; current_time_local time; candidate record; notice_seq bigint;
BEGIN
 IF action IS NULL OR action NOT IN ('partnerDeliveryPreferences','partnerDeliveryConfigure','partnerPushStatus') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
 response=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed');
 IF action='partnerDeliveryConfigure' THEN
  settings=payload->'deliveryPreferences';
  IF jsonb_typeof(settings->'push') IS DISTINCT FROM 'boolean' OR jsonb_typeof(settings->'reminders') IS DISTINCT FROM 'boolean'
   OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=settings->>'timeZone')
   OR ((settings->>'quietStart' IS NULL)<>(settings->>'quietEnd' IS NULL))
   OR settings->>'quietStart'=settings->>'quietEnd' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
  END IF;
  INSERT INTO pactaris.task_delivery_preferences AS p
   (household_id,member_id,push_enabled,reminders,enabled_at,quiet_start,quiet_end,time_zone)
   VALUES(target,m.id,(settings->>'push')::boolean,(settings->>'reminders')::boolean,
    CASE WHEN (settings->>'push')::boolean THEN clock_timestamp() END,
    (settings->>'quietStart')::time,(settings->>'quietEnd')::time,settings->>'timeZone')
  ON CONFLICT(household_id,member_id) DO UPDATE SET push_enabled=EXCLUDED.push_enabled,reminders=EXCLUDED.reminders,
   quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,time_zone=EXCLUDED.time_zone,
   enabled_at=CASE WHEN EXCLUDED.push_enabled AND p.push_enabled THEN p.enabled_at ELSE EXCLUDED.enabled_at END;
  response=response||jsonb_build_object('status','applied');
 END IF;
 SELECT * INTO pref FROM pactaris.task_delivery_preferences WHERE household_id=target AND member_id=m.id;
 IF action<>'partnerPushStatus' THEN
  RETURN response||jsonb_build_object('deliveryPreferences',jsonb_build_object('push',coalesce(pref.push_enabled,false),'reminders',coalesce(pref.reminders,false),
   'quietStart',to_char(date '2000-01-01'+pref.quiet_start,'HH24:MI'),'quietEnd',to_char(date '2000-01-01'+pref.quiet_end,'HH24:MI'),'timeZone',coalesce(pref.time_zone,h.time_zone)));
 END IF;
 IF NOT coalesce(pref.push_enabled,false) OR h.status<>'active' OR m.safety_paused THEN
  RETURN response||jsonb_build_object('pushSequence',NULL);
 END IF;
 current_time_local=(now() AT TIME ZONE pref.time_zone)::time;
 IF pref.quiet_start IS NOT NULL AND
  (CASE WHEN pref.quiet_start<pref.quiet_end THEN current_time_local>=pref.quiet_start AND current_time_local<pref.quiet_end
   ELSE current_time_local>=pref.quiet_start OR current_time_local<pref.quiet_end END) THEN
  RETURN response||jsonb_build_object('pushSequence',NULL);
 END IF;
 SELECT max(n.push_seq) INTO notice_seq FROM pactaris.member_notices n WHERE n.household_id=target AND n.recipient_id=m.id AND NOT n.read
  AND n.push_seq>(payload->>'pushAfter')::bigint
  AND n.pushed_eligible_since>=greatest((payload->>'pushSince')::timestamptz,pref.enabled_at,now()-interval '24 hours');
 FOR candidate IN SELECT i.push_seq,i.kind,t.agreement_id,t.agreement_version,t.policy_id,t.policy_version
  FROM pactaris.task_inbox i JOIN pactaris.partner_tasks t ON t.household_id=i.household_id AND t.id=i.task_id
  LEFT JOIN pactaris.task_inbox_preferences p ON p.household_id=i.household_id AND p.membership_id=i.recipient
  WHERE i.household_id=target AND i.recipient=m.id AND NOT i.read AND i.push_seq>(payload->>'pushAfter')::bigint
   AND i.pushed_eligible_since>=greatest((payload->>'pushSince')::timestamptz,pref.enabled_at,now()-interval '24 hours')
   AND t.state NOT IN ('declined','cancelled')
   AND CASE i.kind WHEN 'assigned' THEN coalesce(p.assigned,true) WHEN 'submitted' THEN coalesce(p.submitted,true)
    WHEN 'reviewed' THEN coalesce(p.reviewed,true) ELSE pref.reminders END
  ORDER BY i.push_seq DESC LIMIT 25 LOOP
  IF (candidate.kind='reviewed' OR candidate.policy_id IS NULL OR EXISTS(SELECT 1 FROM pactaris.assignment_policies
   WHERE household_id=target AND id=candidate.policy_id AND version=candidate.policy_version AND state='active'))
   AND pactaris.activity_guard(target,instance,actor,m.id,candidate.agreement_id,candidate.agreement_version,
    CASE WHEN candidate.kind='reminder' THEN 'reminder' ELSE 'task' END,h.safety_version) THEN
   RETURN response||jsonb_build_object('pushSequence',greatest(candidate.push_seq,coalesce(notice_seq,0))::text);
  END IF;
 END LOOP;
 RETURN response||jsonb_build_object('pushSequence',notice_seq::text);
END $$;
