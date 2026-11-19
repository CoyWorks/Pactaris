ALTER TABLE pactaris.task_inbox DROP CONSTRAINT task_inbox_kind_check,
 ADD CONSTRAINT task_inbox_kind_check CHECK(kind IN ('assigned','submitted','reviewed','reminder')),
 ADD COLUMN push_seq bigint GENERATED ALWAYS AS IDENTITY,
 ADD COLUMN pushed_eligible_since timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE pactaris.task_inbox ALTER COLUMN pushed_eligible_since SET DEFAULT clock_timestamp();
CREATE INDEX task_inbox_push_candidates ON pactaris.task_inbox(household_id,recipient,push_seq DESC) WHERE NOT read;

CREATE TABLE pactaris.task_delivery_preferences (
 household_id uuid NOT NULL, member_id uuid NOT NULL,
 push_enabled boolean NOT NULL, reminders boolean NOT NULL,
 enabled_at timestamptz,
 quiet_start time, quiet_end time, time_zone text NOT NULL,
 PRIMARY KEY(household_id,member_id),
 FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id),
 CHECK((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start<>quiet_end))
);
ALTER TABLE pactaris.task_delivery_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.task_delivery_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.task_delivery_preferences USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.task_delivery_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; pref pactaris.task_delivery_preferences;
 response jsonb; settings jsonb; current_time_local time; candidate record;
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
   RETURN response||jsonb_build_object('pushSequence',candidate.push_seq::text);
  END IF;
 END LOOP;
 RETURN response||jsonb_build_object('pushSequence',NULL);
END $$;
REVOKE ALL ON FUNCTION pactaris.task_delivery_command(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;

CREATE TABLE pactaris.task_reminder_jobs (
 household_id uuid NOT NULL, task_id uuid NOT NULL, run_after timestamptz NOT NULL, due_at timestamptz NOT NULL,
 finished boolean NOT NULL DEFAULT false,
 PRIMARY KEY(household_id,task_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id) ON DELETE CASCADE
);
CREATE INDEX task_reminders_due ON pactaris.task_reminder_jobs(run_after) WHERE NOT finished;
ALTER TABLE pactaris.task_reminder_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.task_reminder_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.task_reminder_jobs USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.queue_task_reminder() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE deadline timestamptz;
BEGIN
 deadline=(NEW.fields->>'dueAt')::timestamptz;
 IF deadline>now() THEN
  INSERT INTO pactaris.task_reminder_jobs(household_id,task_id,run_after,due_at)
   VALUES(NEW.household_id,NEW.id,greatest(deadline-interval '1 hour',coalesce(NEW.available_at,now())),deadline)
  ON CONFLICT(household_id,task_id) DO UPDATE SET run_after=EXCLUDED.run_after,due_at=EXCLUDED.due_at
   WHERE NOT pactaris.task_reminder_jobs.finished;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.queue_task_reminder() FROM PUBLIC;
CREATE TRIGGER queue_task_reminder AFTER INSERT OR UPDATE OF fields,available_at ON pactaris.partner_tasks
 FOR EACH ROW EXECUTE FUNCTION pactaris.queue_task_reminder();

CREATE FUNCTION pactaris.run_task_reminders(instance uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE job pactaris.task_reminder_jobs; task pactaris.partner_tasks; h pactaris.households; m pactaris.memberships;
BEGIN
 FOR job IN SELECT j.* FROM pactaris.task_reminder_jobs j JOIN pactaris.households hh ON hh.id=j.household_id
  WHERE hh.instance_id=instance AND NOT j.finished AND j.run_after<=now() ORDER BY j.run_after,j.task_id LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pactaris.household.'||job.household_id::text,0)) THEN CONTINUE; END IF;
  UPDATE pactaris.task_reminder_jobs q SET finished=true WHERE q.household_id=job.household_id AND q.task_id=job.task_id
   AND NOT q.finished AND q.run_after<=now() RETURNING q.* INTO job;
  IF NOT FOUND THEN CONTINUE; END IF;
  IF job.due_at<=now() THEN RETURN true; END IF;
  SELECT * INTO task FROM pactaris.partner_tasks WHERE household_id=job.household_id AND id=job.task_id;
  SELECT * INTO h FROM pactaris.households WHERE id=job.household_id AND instance_id=instance;
  SELECT * INTO m FROM pactaris.memberships WHERE household_id=job.household_id AND id=task.assignee_id AND status='active';
  IF m.id IS NOT NULL AND task.state IN ('assigned','accepted','in_progress','changes_requested')
   AND EXISTS(SELECT 1 FROM pactaris.task_delivery_preferences p WHERE p.household_id=job.household_id AND p.member_id=m.id AND p.reminders)
   AND (task.policy_id IS NULL OR EXISTS(SELECT 1 FROM pactaris.assignment_policies WHERE household_id=job.household_id
    AND id=task.policy_id AND version=task.policy_version AND state='active'))
   AND pactaris.activity_guard(h.id,instance,m.account_id,m.id,task.agreement_id,task.agreement_version,'reminder',h.safety_version) THEN
   INSERT INTO pactaris.task_inbox(household_id,id,task_id,recipient,kind,created_at)
    VALUES(h.id,gen_random_uuid(),task.id,m.id,'reminder',now());
  END IF;
  RETURN true;
 END LOOP;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION pactaris.run_task_reminders(uuid) FROM PUBLIC;
