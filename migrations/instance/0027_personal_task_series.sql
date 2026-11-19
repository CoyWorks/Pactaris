CREATE TABLE pactaris.personal_task_series (
 household_id uuid NOT NULL, id uuid NOT NULL, version bigint NOT NULL,
 creator_id uuid NOT NULL, fields jsonb NOT NULL, schedule jsonb NOT NULL,
 household_epoch bigint NOT NULL, member_epoch bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('active','blocked','finished','stopped','superseded')),
 cursor_date date NOT NULL, run_after timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 PRIMARY KEY(household_id,id,version),
 FOREIGN KEY(household_id,creator_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX personal_task_series_due ON pactaris.personal_task_series(run_after) WHERE state='active';
CREATE UNIQUE INDEX personal_task_series_current ON pactaris.personal_task_series(household_id,id) WHERE state<>'superseded';
ALTER TABLE pactaris.personal_task_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.personal_task_series FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.personal_task_series USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

ALTER TABLE pactaris.tasks ADD COLUMN personal_series_id uuid, ADD COLUMN personal_series_version bigint, ADD COLUMN personal_occurrence_date date,
 ADD FOREIGN KEY(household_id,personal_series_id,personal_series_version) REFERENCES pactaris.personal_task_series(household_id,id,version),
 ADD UNIQUE(household_id,personal_series_id,personal_occurrence_date);

CREATE OR REPLACE FUNCTION pactaris.combined_task_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE cap integer; used bigint; key text;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  IF NEW.state<>'open' THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state='open' THEN RETURN NEW;END IF;END IF;
  key='workspace.capacity';
 ELSIF TG_TABLE_NAME IN ('task_series','personal_task_series') THEN
  IF NEW.state NOT IN ('active','blocked') THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state IN ('active','blocked') THEN RETURN NEW;END IF;END IF;
  key=CASE WHEN TG_TABLE_NAME='personal_task_series' THEN 'workspace.capacity' ELSE 'partner.capacity' END;
 ELSE
  IF NEW.state IN ('done','declined','cancelled') THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state NOT IN ('done','declined','cancelled') THEN RETURN NEW;END IF;END IF;
  key='partner.capacity';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||NEW.household_id::text,0));
 SELECT CASE WHEN capabilities->>'tasks.active.max'~'^[0-9]{1,6}$' THEN (capabilities->>'tasks.active.max')::int ELSE 0 END
 INTO cap FROM pactaris.household_entitlements WHERE household_id=NEW.household_id;
 SELECT (SELECT count(*) FROM pactaris.tasks WHERE household_id=NEW.household_id AND state='open')
  +(SELECT count(*) FROM pactaris.partner_tasks WHERE household_id=NEW.household_id AND state NOT IN ('done','declined','cancelled'))
  +(SELECT count(*) FROM pactaris.task_series WHERE household_id=NEW.household_id AND state IN ('active','blocked'))
  +(SELECT count(*) FROM pactaris.personal_task_series WHERE household_id=NEW.household_id AND state IN ('active','blocked')) INTO used;
 IF used>=coalesce(cap,0) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=key;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_series_capacity BEFORE INSERT OR UPDATE OF state ON pactaris.personal_task_series
 FOR EACH ROW EXECUTE FUNCTION pactaris.combined_task_capacity();

CREATE FUNCTION pactaris.personal_series_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.personal_task_series SET state='stopped'
   WHERE household_id=NEW.household_id AND creator_id=NEW.id AND state IN ('active','blocked');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.personal_series_departure() FROM PUBLIC;
CREATE TRIGGER personal_series_departure AFTER UPDATE OF status ON pactaris.memberships
 FOR EACH ROW EXECUTE FUNCTION pactaris.personal_series_departure();

CREATE FUNCTION pactaris.personal_series_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; s pactaris.personal_task_series; recorded pactaris.workspace_receipts;
 result jsonb; items jsonb; next_id uuid; rule jsonb; task_fields jsonb; series_id uuid; revision bigint;
BEGIN
 IF action IS NULL OR action NOT IN ('personalSeriesList','personalSeriesSave','personalSeriesStop')
  OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.workspace.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 result=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied');
 IF action='personalSeriesList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('seriesId',p.id,'version',p.version::text,'state',p.state,'fields',p.fields,'schedule',p.schedule) ORDER BY p.id),'[]')
   INTO items FROM (SELECT * FROM pactaris.personal_task_series WHERE household_id=target AND creator_id=m.id AND state<>'superseded'
   AND (body->>'after' IS NULL OR id>(body->>'after')::uuid) ORDER BY id LIMIT 11) p;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'seriesId')::uuid; items=items-10; END IF;
  RETURN result||jsonb_build_object('status','listed','series',items,'nextCursor',next_id);
 END IF;
 SELECT * INTO recorded FROM pactaris.workspace_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF recorded.household_id<>target OR recorded.actor_membership_id<>m.id OR recorded.request_hash<>fingerprint
   THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  RETURN recorded.result;
 END IF;
 IF body?'seriesId' THEN
  SELECT * INTO s FROM pactaris.personal_task_series WHERE household_id=target AND id=(body->>'seriesId')::uuid
   AND creator_id=m.id AND state<>'superseded';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF s.version::text IS DISTINCT FROM body->>'version' OR s.state='stopped' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
 END IF;
 IF action='personalSeriesStop' THEN
  IF s.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
  UPDATE pactaris.personal_task_series SET state='stopped' WHERE household_id=target AND id=s.id AND version=s.version;
  series_id=s.id;
 ELSE
  IF h.status<>'active' OR m.safety_paused OR h.safety_version::text IS DISTINCT FROM body->>'epoch'
   OR m.safety_epoch::text IS DISTINCT FROM body->>'memberEpoch' OR EXISTS(SELECT 1 FROM pactaris.personal_limits
    WHERE household_id=target AND membership_id=m.id AND limits->'blockedActivities'?'task')
   THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.paused'; END IF;
  rule=body->'schedule'; task_fields=body->'fields';
  IF rule->>'period' IS NULL OR rule->>'period' NOT IN ('daily','weekly','once')
   OR rule->>'startDate' IS NULL OR (rule->>'endDate')::date<(rule->>'startDate')::date
   OR rule->>'availableTime' IS NULL OR (rule->>'dueMinutes')::int NOT BETWEEN 1 AND 10080
   OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=rule->>'timeZone')
   OR task_fields->>'assignment' IS DISTINCT FROM 'self' OR nullif(task_fields->>'title','') IS NULL
   OR char_length(task_fields->>'title')>120 OR char_length(task_fields->>'description')>1000
   OR coalesce(task_fields->>'priority','') NOT IN ('low','normal','high') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
  END IF;
  series_id=coalesce(s.id,operation); revision=coalesce(s.version,0)+1;
  IF s.id IS NOT NULL THEN
   UPDATE pactaris.personal_task_series SET state='superseded' WHERE household_id=target AND id=s.id AND version=s.version;
  END IF;
  INSERT INTO pactaris.personal_task_series(household_id,id,version,creator_id,fields,schedule,household_epoch,member_epoch,state,cursor_date)
   VALUES(target,series_id,revision,m.id,task_fields,rule,h.safety_version,m.safety_epoch,'active',
    greatest((rule->>'startDate')::date,(now() AT TIME ZONE (rule->>'timeZone'))::date));
 END IF;
 INSERT INTO pactaris.workspace_receipts VALUES(operation,target,m.id,fingerprint,result);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.'||action,series_id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.workspace_outbox VALUES(operation,target,'workspace.'||action,now());
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION pactaris.personal_series_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

CREATE FUNCTION pactaris.run_personal_scheduler(instance uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE s pactaris.personal_task_series; h pactaris.households; m pactaris.memberships; job record;
 day date; today date; available timestamptz; due timestamptz; op uuid; result text; end_date date;
BEGIN
 FOR job IN SELECT q.household_id,q.id,q.version FROM pactaris.personal_task_series q JOIN pactaris.households hh ON hh.id=q.household_id
  WHERE hh.instance_id=instance AND q.state='active' AND q.run_after<=now() ORDER BY q.run_after,q.id LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pactaris.household.'||job.household_id::text,0)) THEN CONTINUE; END IF;
  SELECT * INTO s FROM pactaris.personal_task_series q WHERE q.household_id=job.household_id AND q.id=job.id
   AND q.version=job.version AND q.state='active' AND q.run_after<=now();
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT * INTO h FROM pactaris.households WHERE id=s.household_id AND instance_id=instance;
  SELECT * INTO m FROM pactaris.memberships WHERE household_id=s.household_id AND id=s.creator_id AND status='active';
  IF h.id IS NULL OR h.status<>'active' OR m.id IS NULL OR m.safety_paused OR h.safety_version<>s.household_epoch
   OR m.safety_epoch<>s.member_epoch OR EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=s.household_id
    AND membership_id=s.creator_id AND limits->'blockedActivities'?'task') THEN
   UPDATE pactaris.personal_task_series SET state='blocked' WHERE household_id=s.household_id AND id=s.id AND version=s.version;
   RETURN 'blocked';
  END IF;
  BEGIN
   today=(now() AT TIME ZONE (s.schedule->>'timeZone'))::date;
   day=greatest(today,s.cursor_date);
   end_date=CASE WHEN s.schedule->>'period'='once' THEN (s.schedule->>'startDate')::date ELSE (s.schedule->>'endDate')::date END;
   IF end_date IS NOT NULL AND day>end_date THEN
    UPDATE pactaris.personal_task_series SET state='finished' WHERE household_id=s.household_id AND id=s.id AND version=s.version;
    RETURN 'processed';
   END IF;
   available=pactaris.task_occurrence_at(s.schedule,day);
   IF day>today OR available>now() THEN
    UPDATE pactaris.personal_task_series SET cursor_date=day,run_after=coalesce(available,day::timestamp AT TIME ZONE (s.schedule->>'timeZone')),attempts=0
     WHERE household_id=s.household_id AND id=s.id AND version=s.version;
    RETURN 'processed';
   END IF;
   due=available+make_interval(mins=>(s.schedule->>'dueMinutes')::int);
   IF due>now() AND NOT EXISTS(SELECT 1 FROM pactaris.tasks WHERE household_id=s.household_id
    AND personal_series_id=s.id AND personal_occurrence_date=day) THEN
    op=gen_random_uuid();
    PERFORM pactaris.workspace_command(s.household_id,instance,m.account_id,op,'taskCreate',
     jsonb_build_object('membershipId',m.id,'epoch',h.safety_version::text,'memberEpoch',m.safety_epoch::text,
       'fields',jsonb_set(s.fields,'{dueAt}',to_jsonb(due))),
     encode(sha256(convert_to(s.id::text||':'||s.version::text||':'||day::text,'UTF8')),'hex'));
    UPDATE pactaris.tasks SET personal_series_id=s.id,personal_series_version=s.version,personal_occurrence_date=day
     WHERE household_id=s.household_id AND id=op;
   END IF;
   UPDATE pactaris.personal_task_series SET cursor_date=day+1,attempts=0,
    state=CASE WHEN day=end_date THEN 'finished' ELSE 'active' END,
    run_after=(day+1)::timestamp AT TIME ZONE (s.schedule->>'timeZone')
    WHERE household_id=s.household_id AND id=s.id AND version=s.version;
   RETURN 'processed';
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM='workspace.capacity' THEN
    UPDATE pactaris.personal_task_series SET attempts=0,run_after=now()+interval '1 hour'
     WHERE household_id=s.household_id AND id=s.id AND version=s.version;
    RETURN 'capacity';
   END IF;
   UPDATE pactaris.personal_task_series SET attempts=attempts+1,
    state=CASE WHEN attempts>=4 THEN 'blocked' ELSE 'active' END,
    run_after=now()+make_interval(secs=>60*power(2,attempts)::int)
    WHERE household_id=s.household_id AND id=s.id AND version=s.version;
   RETURN 'failed';
  END;
 END LOOP;
 RETURN 'idle';
END $$;
REVOKE ALL ON FUNCTION pactaris.run_personal_scheduler(uuid) FROM PUBLIC;
