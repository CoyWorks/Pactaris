-- Additive scheduler. Release-manifest registration is a separate release gate.
CREATE TABLE pactaris.task_series (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_id uuid NOT NULL,assignee_id uuid NOT NULL,policy_id uuid NOT NULL,policy_version bigint NOT NULL,
 version bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled','blocked','finished')),
 fields jsonb NOT NULL,schedule jsonb NOT NULL,epoch bigint NOT NULL,safety_snapshot text NOT NULL,
 PRIMARY KEY(household_id,id),FOREIGN KEY(household_id,creator_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,assignee_id) REFERENCES pactaris.memberships(household_id,id),FOREIGN KEY(household_id,policy_id) REFERENCES pactaris.assignment_policies(household_id,id)
);
CREATE TABLE pactaris.task_series_versions (
 household_id uuid NOT NULL,series_id uuid NOT NULL,version bigint NOT NULL,definition jsonb NOT NULL,at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,series_id,version),FOREIGN KEY(household_id,series_id) REFERENCES pactaris.task_series(household_id,id)
);
CREATE TABLE pactaris.task_generation_jobs (
 household_id uuid NOT NULL,series_id uuid NOT NULL,version bigint NOT NULL,cursor_date date NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','blocked','dead')),attempts integer NOT NULL DEFAULT 0,
 run_after timestamptz NOT NULL DEFAULT now(),last_code text,
 PRIMARY KEY(household_id,series_id,version),FOREIGN KEY(household_id,series_id,version) REFERENCES pactaris.task_series_versions(household_id,series_id,version)
);
CREATE INDEX task_generation_due ON pactaris.task_generation_jobs(run_after) WHERE state='pending';
ALTER TABLE pactaris.partner_tasks ADD COLUMN series_id uuid,ADD COLUMN series_version bigint,ADD COLUMN occurrence_date date,ADD COLUMN available_at timestamptz,
 ADD FOREIGN KEY(household_id,series_id,series_version) REFERENCES pactaris.task_series_versions(household_id,series_id,version),
 ADD UNIQUE(household_id,series_id,series_version,occurrence_date);
DO $$ DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['task_series','task_series_versions','task_generation_jobs'] LOOP
 EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;

-- Calendar arithmetic uses local dates. Nonexistent wall times are skipped;
-- ambiguous times use PostgreSQL's standard-time (later) interpretation once.
CREATE FUNCTION pactaris.task_occurrence_at(rule jsonb,day date) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE wall timestamp;instant timestamptz;
BEGIN
 IF day<(rule->>'startDate')::date OR (rule->>'endDate' IS NOT NULL AND day>(rule->>'endDate')::date)
 OR (rule->>'period'='once' AND day<>(rule->>'startDate')::date)
 OR (rule->>'period'='weekly' AND NOT (rule->'weekdays' @> to_jsonb(extract(isodow FROM day)::int))) THEN RETURN NULL;END IF;
 wall=day+(rule->>'availableTime')::time;instant=wall AT TIME ZONE (rule->>'timeZone');
 IF instant AT TIME ZONE (rule->>'timeZone')<>wall THEN RETURN NULL;END IF;RETURN instant;
END $$;
REVOKE ALL ON FUNCTION pactaris.task_occurrence_at(jsonb,date) FROM PUBLIC;

-- Capacity counts each active/blocked series and every open occurrence, together
-- with private tasks and standalone participant tasks. No content is evicted.
CREATE OR REPLACE FUNCTION pactaris.combined_task_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE cap integer;used bigint;key text;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  IF NEW.state<>'open' THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state='open' THEN RETURN NEW;END IF;END IF;key='workspace.capacity';
 ELSIF TG_TABLE_NAME='task_series' THEN
  IF NEW.state NOT IN ('active','blocked') THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state IN ('active','blocked') THEN RETURN NEW;END IF;END IF;key='partner.capacity';
 ELSE
  IF NEW.state IN ('done','declined','cancelled') THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state NOT IN ('done','declined','cancelled') THEN RETURN NEW;END IF;END IF;key='partner.capacity';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||NEW.household_id::text,0));
 SELECT CASE WHEN capabilities->>'tasks.active.max'~'^[0-9]{1,6}$' THEN (capabilities->>'tasks.active.max')::int ELSE 0 END INTO cap FROM pactaris.household_entitlements WHERE household_id=NEW.household_id;
 SELECT (SELECT count(*) FROM pactaris.tasks WHERE household_id=NEW.household_id AND state='open')+(SELECT count(*) FROM pactaris.partner_tasks WHERE household_id=NEW.household_id AND state NOT IN ('done','declined','cancelled'))+(SELECT count(*) FROM pactaris.task_series WHERE household_id=NEW.household_id AND state IN ('active','blocked')) INTO used;
 IF used>=coalesce(cap,0) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=key;END IF;RETURN NEW;
END $$;
CREATE TRIGGER combined_series_capacity BEFORE INSERT OR UPDATE OF state ON pactaris.task_series FOR EACH ROW EXECUTE FUNCTION pactaris.combined_task_capacity();

-- Existing commands keep their guard/receipt/outbox semantics. The worker calls
-- the private base command inside the same lifecycle-locked transaction.
ALTER FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) RENAME TO partner_command_before_scheduling;
REVOKE ALL ON FUNCTION pactaris.partner_command_before_scheduling(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
-- Remove the old runtime grant as well; only the new wrapper is callable.
DO $$ DECLARE grantee text;BEGIN
 FOR grantee IN SELECT rolname FROM pg_roles WHERE has_function_privilege(oid,'pactaris.partner_command_before_scheduling(uuid,uuid,uuid,uuid,text,jsonb,text)','EXECUTE') AND rolname<>current_user AND NOT rolsuper LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION pactaris.partner_command_before_scheduling(uuid,uuid,uuid,uuid,text,jsonb,text) FROM %I',grantee);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.generate_task_series(target uuid,series uuid,revision bigint,instance uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE s pactaris.task_series;j pactaris.task_generation_jobs;p pactaris.assignment_policies;h pactaris.households;
 creator pactaris.memberships;day date;last_day date;today date;instant timestamptz;op uuid;f jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance;
 IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO s FROM pactaris.task_series WHERE household_id=target AND id=series;
 SELECT * INTO j FROM pactaris.task_generation_jobs WHERE household_id=target AND series_id=series AND version=revision FOR UPDATE;
 IF NOT FOUND OR j.state<>'pending' THEN RETURN;END IF;
 IF s.version<>revision OR s.state<>'active' THEN UPDATE pactaris.task_generation_jobs SET state='done' WHERE household_id=target AND series_id=series AND version=revision;RETURN;END IF;
 SELECT * INTO creator FROM pactaris.memberships WHERE household_id=target AND id=s.creator_id AND status='active';
 SELECT * INTO p FROM pactaris.assignment_policies WHERE household_id=target AND id=s.policy_id AND version=s.policy_version AND state='active';
 IF creator.id IS NULL OR p.id IS NULL OR h.status<>'active' OR h.safety_version<>s.epoch
 OR pactaris.partner_snapshot(target,p.agreement_id,p.agreement_version) IS DISTINCT FROM s.safety_snapshot
 OR NOT pactaris.activity_guard(target,instance,creator.account_id,creator.id,p.agreement_id,p.agreement_version,'task',s.epoch) THEN
  UPDATE pactaris.task_series SET state='blocked' WHERE household_id=target AND id=series;
  UPDATE pactaris.task_generation_jobs SET state='blocked',last_code='scope' WHERE household_id=target AND series_id=series AND version=revision;RETURN;
 END IF;
 today=(now() AT TIME ZONE (s.schedule->>'timeZone'))::date;
 day=greatest(j.cursor_date,today);last_day=least(today+7,coalesce((s.schedule->>'endDate')::date,today+7));
 IF s.schedule->>'period'='once' THEN last_day=least(last_day,(s.schedule->>'startDate')::date);END IF;
 WHILE day<=last_day LOOP
  instant=pactaris.task_occurrence_at(s.schedule,day);
  -- Skip elapsed availability instants, even on the current local date. No backlog.
  IF instant>=now() AND NOT EXISTS(SELECT 1 FROM pactaris.partner_tasks WHERE household_id=target AND series_id=series AND occurrence_date=day AND (series_version=revision OR state<>'cancelled')) THEN
   op=gen_random_uuid();f=jsonb_set(s.fields,'{dueAt}',to_jsonb(to_char((instant+make_interval(mins=>(s.schedule->>'dueMinutes')::int)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
   PERFORM pactaris.partner_command_before_scheduling(target,instance,creator.account_id,op,'partnerAssign',jsonb_build_object('membershipId',creator.id,'policyId',p.id,'policyVersion',p.version::text,'assigneeId',s.assignee_id,'agreementId',p.agreement_id,'agreementVersion',p.agreement_version::text,'fields',f,'epoch',s.epoch::text,'safetyVersion',s.safety_snapshot),encode(sha256(convert_to(series::text||':'||revision::text||':'||day::text,'UTF8')),'hex'));
   UPDATE pactaris.partner_tasks SET series_id=series,series_version=revision,occurrence_date=day,available_at=instant WHERE household_id=target AND id=op;
  END IF;
  day=day+1;
 END LOOP;
 UPDATE pactaris.task_generation_jobs SET cursor_date=greatest(day,j.cursor_date),attempts=0,last_code=NULL,run_after=now()+interval '1 hour',
 state=CASE WHEN (s.schedule->>'period'='once' AND day>(s.schedule->>'startDate')::date) OR (s.schedule->>'endDate' IS NOT NULL AND day>(s.schedule->>'endDate')::date) THEN 'done' ELSE 'pending' END
 WHERE household_id=target AND series_id=series AND version=revision;
 IF EXISTS(SELECT 1 FROM pactaris.task_generation_jobs WHERE household_id=target AND series_id=series AND version=revision AND state='done') THEN
 UPDATE pactaris.task_series SET state='finished' WHERE household_id=target AND id=series;END IF;
END $$;
REVOKE ALL ON FUNCTION pactaris.generate_task_series(uuid,uuid,bigint,uuid) FROM PUBLIC;

-- One bounded job per transaction. Household lock precedes job lock everywhere.
-- A process crash rolls back both effects and claim; no expiring lease can race.
CREATE FUNCTION pactaris.run_task_scheduler(instance uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE j pactaris.task_generation_jobs;code text;
BEGIN
 FOR j IN SELECT q.* FROM pactaris.task_generation_jobs q JOIN pactaris.households h ON h.id=q.household_id WHERE h.instance_id=instance AND q.state='pending' AND q.run_after<=now() ORDER BY q.run_after,q.series_id LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pactaris.household.'||j.household_id::text,0)) THEN CONTINUE;END IF;
  SELECT * INTO j FROM pactaris.task_generation_jobs WHERE household_id=j.household_id AND series_id=j.series_id AND version=j.version FOR UPDATE;
  IF j.state<>'pending' OR j.run_after>now() THEN CONTINUE;END IF;
  BEGIN
   PERFORM pactaris.generate_task_series(j.household_id,j.series_id,j.version,instance);RETURN 'processed';
  EXCEPTION WHEN OTHERS THEN
   code=CASE WHEN SQLERRM='partner.capacity' THEN 'capacity' ELSE 'failed' END;
   UPDATE pactaris.task_generation_jobs SET attempts=attempts+1,state=CASE WHEN attempts>=4 THEN 'dead' ELSE 'pending' END,
    run_after=now()+make_interval(secs=>least(3600,60*power(2,attempts)::int)),last_code=code
    WHERE household_id=j.household_id AND series_id=j.series_id AND version=j.version;
   IF j.attempts>=4 THEN UPDATE pactaris.task_series SET state='blocked' WHERE household_id=j.household_id AND id=j.series_id AND version=j.version;END IF;
   RETURN code;
  END;
 END LOOP;RETURN 'idle';
END $$;
REVOKE ALL ON FUNCTION pactaris.run_task_scheduler(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;s pactaris.task_series;p pactaris.assignment_policies;
 receipt pactaris.partner_receipts;answer jsonb;items jsonb;rule jsonb;f jsonb;t pactaris.partner_tasks;next_id uuid;
BEGIN
 IF action NOT IN ('partnerSeriesList','partnerSeriesCreate','partnerSeriesUpdate','partnerSeriesCancel') THEN
  RETURN pactaris.partner_command_before_scheduling(target,instance,actor,operation,action,payload,fingerprint);
 END IF;
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR h.status='closed' OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
 SELECT * INTO receipt FROM pactaris.partner_receipts WHERE operation_id=operation;
 IF FOUND THEN IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;RETURN receipt.result;END IF;
 IF action='partnerSeriesList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('policyId',x.policy_id,'seriesId',x.id,'version',x.version::text,'creatorId',x.creator_id,'assigneeId',x.assignee_id,'state',x.state,'fields',x.fields,'schedule',x.schedule) ORDER BY x.id),'[]') INTO items
  FROM (SELECT * FROM pactaris.task_series WHERE household_id=target AND m.id IN(creator_id,assignee_id) AND (payload->>'after' IS NULL OR id>(payload->>'after')::uuid) ORDER BY id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'seriesId')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','series',items,'nextCursor',next_id);
 END IF;
 IF action<>'partnerSeriesCreate' THEN
  SELECT * INTO s FROM pactaris.task_series WHERE household_id=target AND id=(payload->>'seriesId')::uuid AND m.id IN(creator_id,assignee_id);
  IF NOT FOUND OR (action='partnerSeriesUpdate' AND s.creator_id<>m.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF s.version::text IS DISTINCT FROM payload->>'version' OR s.state='cancelled' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
 END IF;
 IF action<>'partnerSeriesCancel' THEN
  SELECT * INTO p FROM pactaris.assignment_policies WHERE household_id=target AND id=(payload->>'policyId')::uuid AND version=(payload->>'policyVersion')::bigint AND creator_id=m.id AND state='active';
  IF NOT FOUND OR (s.id IS NOT NULL AND (s.policy_id<>p.id OR s.assignee_id<>p.assignee_id)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,p.agreement_id,p.agreement_version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,p.agreement_id,p.agreement_version,'task',h.safety_version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
  rule=payload->'schedule';f=payload->'fields';
  IF rule IS NULL OR rule->>'period' IS NULL OR rule->>'period' NOT IN ('once','daily','weekly') OR rule->>'startDate' IS NULL OR rule->>'availableTime' IS NULL
  OR rule->>'availableTime'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=rule->>'timeZone')
  OR coalesce((rule->>'dueMinutes')::int,0) NOT BETWEEN 1 AND 10080 OR jsonb_typeof(rule->'weekdays') IS DISTINCT FROM 'array'
  OR f->>'title' IS NULL OR char_length(f->>'title') NOT BETWEEN 1 AND 120 OR f->>'description' IS NULL OR char_length(f->>'description')>500 OR f->>'priority' IS NULL OR f->>'priority' NOT IN ('low','normal','high')
  THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
  IF (rule->>'startDate')::date<(now() AT TIME ZONE (rule->>'timeZone'))::date OR (rule->>'endDate')::date<(rule->>'startDate')::date
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(rule->'weekdays') d WHERE d::int NOT BETWEEN 1 AND 7)
  OR (rule->>'period'='weekly' AND jsonb_array_length(rule->'weekdays') NOT BETWEEN 1 AND 7)
  OR (rule->>'period'<>'weekly' AND jsonb_array_length(rule->'weekdays')<>0) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
 END IF;
 -- Edits replace only future untouched occurrences. Past, started, submitted and
 -- completed work retain their exact definition and decision history.
 IF s.id IS NOT NULL THEN
  FOR t IN UPDATE pactaris.partner_tasks SET state='cancelled',version=version+1 WHERE household_id=target AND series_id=s.id AND available_at>now() AND state IN ('assigned','offered') RETURNING * LOOP
   INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id) VALUES(target,t.id,t.version,'partnerSeriesCancel',m.id);
  END LOOP;
  UPDATE pactaris.task_generation_jobs SET state='done' WHERE household_id=target AND series_id=s.id AND state='pending';
 END IF;
 IF action='partnerSeriesCreate' THEN
  INSERT INTO pactaris.task_series(household_id,id,creator_id,assignee_id,policy_id,policy_version,fields,schedule,epoch,safety_snapshot)
  VALUES(target,operation,m.id,p.assignee_id,p.id,p.version,f,rule,h.safety_version,payload->>'safetyVersion') RETURNING * INTO s;
 ELSE
  UPDATE pactaris.task_series SET version=version+1,state=CASE WHEN action='partnerSeriesCancel' THEN 'cancelled' ELSE 'active' END,
   fields=CASE WHEN action='partnerSeriesCancel' THEN fields ELSE f END,schedule=CASE WHEN action='partnerSeriesCancel' THEN schedule ELSE rule END,
   epoch=CASE WHEN action='partnerSeriesCancel' THEN epoch ELSE h.safety_version END,safety_snapshot=CASE WHEN action='partnerSeriesCancel' THEN safety_snapshot ELSE payload->>'safetyVersion' END
  WHERE household_id=target AND id=s.id RETURNING * INTO s;
 END IF;
 INSERT INTO pactaris.task_series_versions(household_id,series_id,version,definition) VALUES(target,s.id,s.version,to_jsonb(s));
 IF action<>'partnerSeriesCancel' THEN
  INSERT INTO pactaris.task_generation_jobs(household_id,series_id,version,cursor_date) VALUES(target,s.id,s.version,(rule->>'startDate')::date);
  PERFORM pactaris.generate_task_series(target,s.id,s.version,instance);
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','seriesId',s.id);
 INSERT INTO pactaris.partner_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'partner.'||action,s.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.partner_outbox VALUES(operation,target,'partner.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

CREATE FUNCTION pactaris.series_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
 UPDATE pactaris.task_series SET state='cancelled' WHERE household_id=NEW.household_id AND NEW.id IN(creator_id,assignee_id) AND state IN ('active','blocked');
 UPDATE pactaris.task_generation_jobs j SET state='done' FROM pactaris.task_series s WHERE s.household_id=j.household_id AND s.id=j.series_id AND s.household_id=NEW.household_id AND NEW.id IN(s.creator_id,s.assignee_id);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER series_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.series_departure();
REVOKE ALL ON FUNCTION pactaris.series_departure() FROM PUBLIC;

-- Preserve the adopted standing authority and all transition rules.
-- Add a bounded assignee-only to-do projection without changing task state.
CREATE OR REPLACE FUNCTION pactaris.partner_command_before_scheduling(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;t pactaris.partner_tasks;receipt pactaris.partner_receipts;a pactaris.agreements;
 answer jsonb;items jsonb;events jsonb;next_id uuid;event_cursor text;new_state text;other_name text;f jsonb;policy pactaris.assignment_policies;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('partnerPolicyList','partnerPolicyPropose','partnerPolicyAccept','partnerPolicyRevoke','partnerAssign','partnerOptions','partnerList','partnerRead','partnerOffer','partnerAccept','partnerDecline','partnerStart','partnerSubmit','partnerApprove','partnerChanges','partnerCancel','partnerReopen') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
 SELECT * INTO receipt FROM pactaris.partner_receipts WHERE operation_id=operation;
 IF FOUND THEN IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;RETURN receipt.result;END IF;
 IF action='partnerPolicyList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('creatorName',(SELECT display_name FROM pactaris.memberships WHERE household_id=target AND id=p.creator_id),'assigneeName',(SELECT display_name FROM pactaris.memberships WHERE household_id=target AND id=p.assignee_id),'agreementLabel',(SELECT terms->>'label' FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=p.agreement_id AND version=p.agreement_version),'policyId',p.id,'version',p.version::text,'agreementId',p.agreement_id,'agreementVersion',p.agreement_version::text,'creatorId',p.creator_id,'assigneeId',p.assignee_id,'mode',p.mode,'state',p.state,'epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,p.agreement_id,p.agreement_version)) ORDER BY p.id),'[]'::jsonb) INTO items
   FROM pactaris.assignment_policies p WHERE p.household_id=target AND m.id IN(p.creator_id,p.assignee_id) AND p.state<>'revoked';
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','policies',items);
 ELSIF action IN ('partnerPolicyPropose','partnerPolicyAccept','partnerPolicyRevoke') THEN
  IF action='partnerPolicyPropose' THEN
   SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=(payload->>'agreementId')::uuid AND version=(payload->>'agreementVersion')::bigint;
   IF NOT FOUND OR payload->>'mode' IS NULL OR payload->>'mode' NOT IN ('direct','explicit') OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=p.membership_id WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND mem.id=(payload->>'assigneeId')::uuid AND mem.id<>m.id AND mem.status='active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   -- A bounded number of live proposals/grants avoids an unbounded private response.
   IF (SELECT count(*) FROM pactaris.assignment_policies WHERE household_id=target AND state<>'revoked')>=25 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.capacity';END IF;
  ELSE
   SELECT * INTO policy FROM pactaris.assignment_policies WHERE household_id=target AND id=(payload->>'policyId')::uuid AND m.id IN(creator_id,assignee_id);
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   IF policy.version::text IS DISTINCT FROM payload->>'version' OR policy.state='revoked' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
   IF action='partnerPolicyAccept' AND (m.id<>policy.assignee_id OR policy.state<>'proposed') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=policy.agreement_id AND version=policy.agreement_version;
  END IF;
  IF action<>'partnerPolicyRevoke' THEN
   IF a.id IS NULL OR h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,a.id,a.version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,'task',h.safety_version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
  END IF;
  IF action='partnerPolicyPropose' THEN
   INSERT INTO pactaris.assignment_policies(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,mode) VALUES(target,operation,m.id,(payload->>'assigneeId')::uuid,a.id,a.version,payload->>'mode') RETURNING * INTO policy;
  ELSE
   UPDATE pactaris.assignment_policies SET state=CASE WHEN action='partnerPolicyAccept' THEN 'active' ELSE 'revoked' END,version=version+1 WHERE household_id=target AND id=policy.id RETURNING * INTO policy;
  END IF;
  INSERT INTO pactaris.assignment_policy_events VALUES(target,policy.id,policy.version,action,m.id,now());
  answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','policyId',policy.id);
  INSERT INTO pactaris.partner_receipts VALUES(operation,target,m.id,fingerprint,answer);
  INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'partner.'||action,policy.id,jsonb_build_object('operationId',operation));
  INSERT INTO pactaris.partner_outbox VALUES(operation,target,'partner.'||action,now());RETURN answer;
 END IF;
 IF action='partnerOptions' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('agreementId',x.id,'agreementVersion',x.version::text,'label',x.terms->>'label','epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,x.id,x.version),
   'assignees',(SELECT jsonb_agg(jsonb_build_object('membershipId',mem.id,'name',mem.display_name) ORDER BY mem.id) FROM pactaris.relationship_participants p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=p.membership_id WHERE p.household_id=target AND p.relationship_id=x.relationship_id AND mem.id<>m.id AND mem.status='active')) ORDER BY x.id),'[]'::jsonb) INTO items
  FROM (SELECT ag.*,av.terms FROM pactaris.agreements ag JOIN pactaris.agreement_versions av ON av.household_id=ag.household_id AND av.agreement_id=ag.id AND av.version=ag.version
   WHERE ag.household_id=target AND (payload->>'after' IS NULL OR ag.id>(payload->>'after')::uuid) AND pactaris.activity_guard(target,instance,actor,m.id,ag.id,ag.version,'task',h.safety_version)
   AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=p.membership_id WHERE p.household_id=target AND p.relationship_id=ag.relationship_id AND mem.id<>m.id AND mem.status='active') ORDER BY ag.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'agreementId')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','choices',items,'nextCursor',next_id);
 ELSIF action='partnerList' THEN
  IF payload->>'filter' IS NULL OR payload->>'filter' NOT IN ('active','closed','todo') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
  SELECT coalesce(jsonb_agg(x.fields||jsonb_build_object('availableAt',CASE WHEN x.available_at IS NULL THEN NULL ELSE to_char(x.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'taskId',x.id,'version',x.version::text,'state',x.state,'creatorId',x.creator_id,'assigneeId',x.assignee_id,'role',CASE WHEN x.creator_id=m.id THEN 'creator' ELSE 'assignee' END,'counterpart',x.counterpart) ORDER BY x.id),'[]'::jsonb) INTO items
   FROM (SELECT p.*,mem.display_name AS counterpart FROM pactaris.partner_tasks p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=CASE WHEN p.creator_id=m.id THEN p.assignee_id ELSE p.creator_id END
    WHERE p.household_id=target AND m.id IN(p.creator_id,p.assignee_id) AND (CASE WHEN payload->>'filter'='todo' THEN p.assignee_id=m.id AND (p.available_at IS NULL OR p.available_at<=now()) AND p.state IN ('assigned','accepted','in_progress','changes_requested') WHEN payload->>'filter'='closed' THEN p.state IN ('done','declined','cancelled') ELSE p.state NOT IN ('done','declined','cancelled') END) AND (payload->>'after' IS NULL OR p.id>(payload->>'after')::uuid) ORDER BY p.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'taskId')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','scheduling',true,'tasks',items,'nextCursor',next_id);
 END IF;
 IF action IN ('partnerOffer','partnerAssign') THEN
  SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=(payload->>'agreementId')::uuid AND version=(payload->>'agreementVersion')::bigint;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=p.membership_id WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND mem.id=(payload->>'assigneeId')::uuid AND mem.status='active' AND mem.id<>m.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,a.id,a.version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,'task',h.safety_version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
  IF action='partnerAssign' THEN
   SELECT * INTO policy FROM pactaris.assignment_policies WHERE household_id=target AND id=(payload->>'policyId')::uuid AND version=(payload->>'policyVersion')::bigint AND creator_id=m.id AND assignee_id=(payload->>'assigneeId')::uuid AND agreement_id=a.id AND agreement_version=a.version AND state='active';
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  END IF;
  f=payload->'fields';
  IF f->>'title' IS NULL OR char_length(f->>'title') NOT BETWEEN 1 AND 120 OR f->>'description' IS NULL OR char_length(f->>'description')>500 OR f->>'priority' IS NULL OR f->>'priority' NOT IN ('low','normal','high') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
  INSERT INTO pactaris.partner_tasks(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,fields,policy_id,policy_version,state) VALUES(target,operation,m.id,(payload->>'assigneeId')::uuid,a.id,a.version,f,policy.id,policy.version,CASE WHEN policy.mode='direct' THEN 'assigned' ELSE 'offered' END) RETURNING * INTO t;
 ELSE
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid AND m.id IN (creator_id,assignee_id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF action='partnerRead' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('version',e.version::text,'action',e.action,'actorId',e.actor_id,'note',e.note,'at',e.at) ORDER BY e.version),'[]'::jsonb) INTO events FROM (SELECT * FROM pactaris.partner_events WHERE household_id=target AND task_id=t.id AND version>coalesce((payload->>'afterVersion')::bigint,0) ORDER BY version LIMIT 11) e;
   IF jsonb_array_length(events)=11 THEN event_cursor=events->9->>'version';events=events-10;END IF;
   SELECT display_name INTO other_name FROM pactaris.memberships WHERE household_id=target AND id=CASE WHEN t.creator_id=m.id THEN t.assignee_id ELSE t.creator_id END;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','task',t.fields||jsonb_build_object('availableAt',CASE WHEN t.available_at IS NULL THEN NULL ELSE to_char(t.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'taskId',t.id,'version',t.version::text,'state',t.state,'creatorId',t.creator_id,'assigneeId',t.assignee_id,'role',CASE WHEN t.creator_id=m.id THEN 'creator' ELSE 'assignee' END,'counterpart',other_name,'agreementId',t.agreement_id,'agreementVersion',t.agreement_version::text,'agreementLabel',(SELECT terms->>'label' FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=t.agreement_id AND version=t.agreement_version),'epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version),'assignmentMode',coalesce((SELECT mode FROM pactaris.assignment_policies WHERE household_id=target AND id=t.policy_id),'offer'),'policyVersion',t.policy_version::text,'eligible',pactaris.assignment_policy_current(target,t.policy_id,t.policy_version) AND pactaris.activity_guard(target,instance,actor,m.id,t.agreement_id,t.agreement_version,'task',h.safety_version),'events',events,'nextEventCursor',event_cursor));
  END IF;
  IF action='partnerStart' AND t.available_at>now() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
  IF t.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
  IF action='partnerCancel' THEN
   IF t.state IN ('done','declined','cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;new_state='cancelled';
  ELSIF action='partnerDecline' THEN
   IF m.id<>t.assignee_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   IF t.state<>'offered' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;new_state='declined';
  ELSE
   IF (action IN ('partnerAccept','partnerStart','partnerSubmit') AND m.id<>t.assignee_id) OR (action IN ('partnerApprove','partnerChanges','partnerReopen') AND m.id<>t.creator_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   IF (action='partnerAccept' AND t.state<>'offered') OR (action='partnerStart' AND t.state NOT IN ('assigned','accepted','changes_requested')) OR (action='partnerSubmit' AND t.state<>'in_progress') OR (action IN ('partnerApprove','partnerChanges') AND t.state<>'submitted') OR (action='partnerReopen' AND t.state<>'done') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
   IF NOT pactaris.assignment_policy_current(target,t.policy_id,t.policy_version) OR h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,t.agreement_id,t.agreement_version,'task',h.safety_version) OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id IN(t.creator_id,t.assignee_id) AND status<>'active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
   IF action IN ('partnerSubmit','partnerChanges') AND (payload->>'note' IS NULL OR char_length(payload->>'note') NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
   new_state=CASE action WHEN 'partnerAccept' THEN 'accepted' WHEN 'partnerStart' THEN 'in_progress' WHEN 'partnerSubmit' THEN 'submitted' WHEN 'partnerApprove' THEN 'done' WHEN 'partnerChanges' THEN 'changes_requested' ELSE CASE WHEN t.policy_id IS NOT NULL AND (SELECT mode FROM pactaris.assignment_policies WHERE household_id=target AND id=t.policy_id)='direct' THEN 'assigned' ELSE 'offered' END END;
  END IF;
  UPDATE pactaris.partner_tasks SET state=new_state,version=version+1 WHERE household_id=target AND id=t.id RETURNING * INTO t;
 END IF;
 INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,t.id,t.version,action,m.id,coalesce(payload->>'note',''));
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','taskId',t.id);
 INSERT INTO pactaris.partner_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'partner.'||action,t.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.partner_outbox VALUES(operation,target,'partner.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command_before_scheduling(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
