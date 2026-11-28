-- Moving an item to another day in the planner (owner request, 28 November 2026). Only one-off items with a
-- due date move: a person's own open task, or a Dom/sub task the person created and that is not finished.
-- Repeating items do not move. The time of day stays; only the date changes, in the viewer's time zone.
-- The new date may not be in the past, and the plan horizon (0072) applies as for any moved date.
CREATE FUNCTION pactaris.planner_move(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;zone text;day date;t pactaris.tasks;p pactaris.partner_tasks;due timestamptz;moved timestamptz;
BEGIN
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 -- Moving is a change: a paused dynamic or a personal pause stops it, as for any edit.
 IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.paused'; END IF;
 zone=body->>'timeZone';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) OR body->>'day' IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 day=(body->>'day')::date;
 IF day<(now() AT TIME ZONE zone)::date THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 IF body->>'kind'='task' THEN
  SELECT * INTO t FROM pactaris.tasks WHERE household_id=target AND id=(body->>'itemId')::uuid AND creator_membership_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF t.state<>'open' OR t.personal_series_id IS NOT NULL OR t.due_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  due=t.due_at;
  moved=(day+(due AT TIME ZONE zone)::time) AT TIME ZONE zone;
  IF moved<>due THEN
   UPDATE pactaris.tasks SET due_at=moved,version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=t.id;
  END IF;
 ELSIF body->>'kind'='partnerTask' THEN
  SELECT * INTO p FROM pactaris.partner_tasks WHERE household_id=target AND id=(body->>'itemId')::uuid AND creator_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF p.state IN ('done','declined','cancelled') OR p.series_id IS NOT NULL OR p.fields->>'dueAt' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  due=(p.fields->>'dueAt')::timestamptz;
  moved=(day+(due AT TIME ZONE zone)::time) AT TIME ZONE zone;
  IF moved<>due THEN
   UPDATE pactaris.partner_tasks SET fields=jsonb_set(fields,'{dueAt}',to_jsonb(to_char(moved AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),version=version+1
    WHERE household_id=target AND id=p.id;
   INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,p.id,p.version+1,'partnerMove',m.id,'');
   -- A reminder that was already sent for the old date is due again for the new one.
   UPDATE pactaris.task_reminder_jobs SET finished=false,due_at=moved,run_after=greatest(moved-interval '1 hour',now())
    WHERE household_id=target AND task_id=p.id AND moved>now();
  END IF;
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
 END IF;
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.plannerMove',(body->>'itemId')::uuid,jsonb_build_object('operationId',body->>'operationId','kind',body->>'kind'));
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied');
END $$;
REVOKE ALL ON FUNCTION pactaris.planner_move(uuid,uuid,uuid,jsonb) FROM PUBLIC;
