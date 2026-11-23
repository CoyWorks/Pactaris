-- Record scheduled breaks alongside each habit, included in the existing personal export.
ALTER TABLE pactaris.authority_habits
 ADD COLUMN breaks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(breaks)='array' AND jsonb_array_length(breaks)<=100),
 ADD COLUMN skip_through date;

-- A safety change fences all pending and overlapping periods, even if the worker runs after resume.
CREATE FUNCTION pactaris.habit_member_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.safety_paused IS DISTINCT FROM NEW.safety_paused THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.household_id AND NEW.id IN (holder_id,subject_id) AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_member_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_member_safety_fence AFTER UPDATE OF safety_paused ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.habit_member_safety_fence();

CREATE FUNCTION pactaris.habit_household_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.id AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_household_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_household_safety_fence AFTER UPDATE OF status ON pactaris.households FOR EACH ROW EXECUTE FUNCTION pactaris.habit_household_safety_fence();

CREATE FUNCTION pactaris.habit_link_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.state IS DISTINCT FROM NEW.state THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.household_id AND subject_id=NEW.sub_id AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_link_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_link_safety_fence AFTER UPDATE OF state ON pactaris.authority_links FOR EACH ROW EXECUTE FUNCTION pactaris.habit_link_safety_fence();

CREATE FUNCTION pactaris.habit_delegation_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.tasks IS DISTINCT FROM NEW.tasks OR OLD.outcomes IS DISTINCT FROM NEW.outcomes OR OLD.ends_at IS DISTINCT FROM NEW.ends_at THEN
  UPDATE pactaris.authority_habits SET skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now()))
   WHERE household_id=NEW.household_id AND holder_id=NEW.delegate_id AND subject_id=(SELECT sub_id FROM pactaris.authority_links WHERE household_id=NEW.household_id AND id=NEW.link_id) AND state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_delegation_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_delegation_safety_fence AFTER INSERT OR UPDATE OF state,tasks,outcomes,ends_at ON pactaris.authority_delegations FOR EACH ROW EXECUTE FUNCTION pactaris.habit_delegation_safety_fence();

CREATE FUNCTION pactaris.habit_relationship_safety_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR OLD.paused IS DISTINCT FROM NEW.paused THEN
  UPDATE pactaris.authority_habits a SET skip_through=greatest(a.skip_through,pactaris.habit_period_start(a.period,a.time_zone,now()))
   FROM pactaris.authority_pairs p WHERE p.household_id=NEW.household_id AND p.relationship_id=NEW.relationship_id
    AND a.household_id=p.household_id AND a.holder_id=p.holder_id AND a.subject_id=p.subject_id AND a.state<>'archived';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_relationship_safety_fence() FROM PUBLIC;
CREATE TRIGGER habit_relationship_safety_fence AFTER INSERT OR UPDATE OF paused ON pactaris.relationship_holds FOR EACH ROW EXECUTE FUNCTION pactaris.habit_relationship_safety_fence();

-- Erasure removes break dates for either participant; departure already archives the habit.
CREATE FUNCTION pactaris.habit_break_erasure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.account_erased_at IS NULL AND NEW.account_erased_at IS NOT NULL THEN
  UPDATE pactaris.authority_habits SET breaks='[]'::jsonb WHERE household_id=NEW.household_id AND NEW.id IN (holder_id,subject_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_break_erasure() FROM PUBLIC;
CREATE TRIGGER habit_break_erasure AFTER UPDATE OF account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.habit_break_erasure();

CREATE FUNCTION pactaris.habit_break_overlap(breaks jsonb,from_day date,until_day date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(breaks) b WHERE (b->>'start')::date<=until_day AND (b->>'end')::date>=from_day)
$$;
REVOKE ALL ON FUNCTION pactaris.habit_break_overlap(jsonb,date,date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pactaris.run_authority_habits(instance uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE x pactaris.authority_habits;job record;h pactaris.households;total integer;outcome text;applied jsonb;allowed boolean;done integer:=0;step integer;streak integer;mr record;
BEGIN
 FOR job IN SELECT a.household_id,a.id FROM pactaris.authority_habits a JOIN pactaris.households hh ON hh.id=a.household_id
  WHERE hh.instance_id=instance AND a.state='active'
   AND a.next_period<pactaris.habit_period_start(a.period,a.time_zone,now()) ORDER BY a.next_period,a.id LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pactaris.household.'||job.household_id::text,0)) THEN CONTINUE; END IF;
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=job.household_id AND id=job.id AND state='active' FOR UPDATE;
  IF NOT FOUND OR x.next_period>=pactaris.habit_period_start(x.period,x.time_zone,now()) THEN CONTINUE; END IF;
  SELECT * INTO h FROM pactaris.households WHERE id=x.household_id;
  step=CASE WHEN x.period='weekly' THEN 7 ELSE 1 END;
  total=pactaris.habit_period_total(x.household_id,x.id,x.period,x.time_zone,x.next_period);
  outcome=CASE WHEN (x.mode='minimum' AND total>=x.goal) OR (x.mode='maximum' AND total<=x.goal) THEN 'reached' ELSE 'missed' END;
  allowed=(x.skip_through IS NULL OR x.next_period>x.skip_through)
   AND NOT pactaris.habit_break_overlap(x.breaks,x.next_period,x.next_period+step-1)
   AND NOT EXISTS(SELECT 1 FROM pactaris.authority_habit_results r WHERE r.household_id=x.household_id AND r.habit_id=x.id AND r.period_start=x.next_period)
   AND (x.period<>'daily' OR extract(isodow from x.next_period)::integer=ANY(x.weekdays))
   AND NOT EXISTS(SELECT 1 FROM pactaris.authority_pairs p JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.paused WHERE p.household_id=x.household_id AND p.holder_id=x.holder_id AND p.subject_id=x.subject_id) AND h.status='active' AND pactaris.authority_area(x.household_id,x.holder_id,x.subject_id,'outcomes')
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m LEFT JOIN pactaris.personal_limits l ON l.household_id=m.household_id AND l.membership_id=m.id
    WHERE m.household_id=x.household_id AND m.id IN (x.holder_id,x.subject_id) AND (m.status<>'active' OR m.safety_paused
     OR coalesce(l.limits->'blockedActivities','[]'::jsonb)?CASE WHEN outcome='reached' THEN 'reward' ELSE 'consequence' END));
  applied='{}'::jsonb;
  IF allowed AND outcome='reached' THEN
   IF h.points_enabled AND x.reward_points IS NOT NULL THEN
    INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,x.reward_points,left(x.title,200));
    applied=applied||jsonb_build_object('points',x.reward_points);
   END IF;
   IF h.points_enabled AND x.milestone_every IS NOT NULL THEN
    -- Streak including this reached period; a bonus every N reached in a row. Skipped (paused) periods are neutral.
    streak=1;
    FOR mr IN SELECT result FROM pactaris.authority_habit_results WHERE household_id=x.household_id AND habit_id=x.id AND period_start<x.next_period ORDER BY period_start DESC LOOP
     IF mr.result='reached' THEN streak=streak+1; ELSIF mr.result='missed' THEN EXIT; END IF;
    END LOOP;
    IF streak % x.milestone_every = 0 THEN
     INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,x.milestone_points,left(x.title,200));
     applied=applied||jsonb_build_object('milestonePoints',x.milestone_points,'streak',streak);
    END IF;
   END IF;
  ELSIF allowed AND outcome='missed' THEN
   IF h.points_enabled AND x.penalty_points IS NOT NULL THEN
    INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,-x.penalty_points,left(x.title,200));
    applied=applied||jsonb_build_object('points',-x.penalty_points);
   END IF;
   IF x.punishment IS NOT NULL THEN
    applied=applied||jsonb_build_object('punishmentTaskId',gen_random_uuid());
    IF NOT pactaris.authority_punish(x.household_id,x.holder_id,x.subject_id,(applied->>'punishmentTaskId')::uuid,x.punishment,left(x.title,500),NULL) THEN
     applied=applied-'punishmentTaskId';
    END IF;
   END IF;
  END IF;
  INSERT INTO pactaris.authority_habit_results(household_id,habit_id,period_start,total,result,outcome)
   VALUES(x.household_id,x.id,x.next_period,total,CASE WHEN allowed THEN outcome ELSE 'skipped' END,applied) ON CONFLICT DO NOTHING;
  -- Periods missed while the worker was down are recorded once without outcomes.
  UPDATE pactaris.authority_habits SET next_period=CASE WHEN next_period+step<pactaris.habit_period_start(period,time_zone,now())-step*7
   THEN pactaris.habit_period_start(period,time_zone,now())-step ELSE next_period+step END WHERE household_id=x.household_id AND id=x.id;
  done=done+1;
 END LOOP;
 RETURN CASE WHEN done=0 THEN 'idle' ELSE 'processed' END;
END $$;
REVOKE ALL ON FUNCTION pactaris.run_authority_habits(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pactaris.authority_habit_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;x pactaris.authority_habits;e pactaris.authority_habit_entries;
 prior pactaris.authority_receipts;answer jsonb;items jsonb;resource uuid;f jsonb;zone text;
BEGIN
 IF action IS NULL OR action NOT IN ('habitList','habitSave','habitState','habitRecord','habitReverse','habitBreakAdd','habitBreakCancel') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.authority.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 IF action='habitList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('habitId',y.id,'holderId',y.holder_id,'holderName',hm.display_name,'subjectId',y.subject_id,'subjectName',sm.display_name,
    'title',y.title,'description',y.description,'breaks',y.breaks,'weekdays',to_jsonb(y.weekdays),'period',y.period,'mode',y.mode,'target',y.goal,'timeZone',y.time_zone,
    'rewardPoints',y.reward_points,'penaltyPoints',y.penalty_points,'punishment',y.punishment,'milestoneEvery',y.milestone_every,'milestonePoints',y.milestone_points,'streaks',pactaris.habit_streaks(target,y.id),'state',y.state,'version',y.version::text,
    'periodStart',pactaris.habit_period_start(y.period,y.time_zone,now()),
    'currentTotal',pactaris.habit_period_total(target,y.id,y.period,y.time_zone,pactaris.habit_period_start(y.period,y.time_zone,now())),
    'canEdit',y.holder_id=m.id OR pactaris.authority_area(target,m.id,y.subject_id,'manage'),'canPlanBreak',m.id=y.subject_id OR (m.id=y.holder_id AND pactaris.authority_area(target,m.id,y.subject_id,'tasks')),'canRecord',m.id IN (y.subject_id,y.holder_id) AND NOT pactaris.habit_break_overlap(y.breaks,pactaris.habit_period_start(y.period,y.time_zone,now()),pactaris.habit_period_start(y.period,y.time_zone,now())+CASE WHEN y.period='weekly' THEN 6 ELSE 0 END) AND (y.period<>'daily' OR extract(isodow from (now() AT TIME ZONE y.time_zone))::integer=ANY(y.weekdays)),
    'results',(SELECT coalesce(jsonb_agg(jsonb_build_object('periodStart',r.period_start,'total',r.total,'result',r.result) ORDER BY r.period_start DESC),'[]'::jsonb)
      FROM (SELECT * FROM pactaris.authority_habit_results WHERE household_id=target AND habit_id=y.id ORDER BY period_start DESC LIMIT 7) r)
   ) ORDER BY y.subject_id,y.created_at),'[]'::jsonb) INTO items
   FROM (SELECT * FROM pactaris.authority_habits z WHERE z.household_id=target AND z.state<>'archived'
    AND (m.id IN (z.subject_id,z.holder_id) OR pactaris.authority_area(target,m.id,z.subject_id,'tasks')) ORDER BY z.created_at LIMIT 50) y
   JOIN pactaris.memberships hm ON hm.household_id=target AND hm.id=y.holder_id JOIN pactaris.memberships sm ON sm.household_id=target AND sm.id=y.subject_id;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','habits',items);
 END IF;
 SELECT * INTO prior FROM pactaris.authority_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='habitSave' THEN
  f=payload->'fields';zone=f->>'timeZone';
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
  IF payload->>'habitId' IS NULL THEN
   SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
   IF NOT FOUND OR NOT pactaris.authority_area(target,m.id,other.id,'tasks') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF h.status<>'active' OR m.safety_paused OR other.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
   IF (SELECT count(*) FROM pactaris.authority_habits WHERE household_id=target AND subject_id=other.id AND state<>'archived')>=50 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
   INSERT INTO pactaris.authority_habits(household_id,id,holder_id,subject_id,title,description,period,mode,goal,time_zone,reward_points,penalty_points,punishment,milestone_every,milestone_points,weekdays,next_period)
    VALUES(target,operation,m.id,other.id,f->>'title',f->>'description',f->>'period',f->>'mode',(f->>'target')::integer,zone,
     (f->>'rewardPoints')::integer,(f->>'penaltyPoints')::integer,f->>'punishment',(f->>'milestoneEvery')::integer,(f->>'milestonePoints')::integer,CASE WHEN f ? 'weekdays' THEN ARRAY(SELECT jsonb_array_elements_text(f->'weekdays')::smallint) ELSE ARRAY[1,2,3,4,5,6,7]::smallint[] END,pactaris.habit_period_start(f->>'period',zone,now()));
   resource=operation;
  ELSE
   SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid FOR UPDATE;
   IF NOT FOUND OR NOT (x.holder_id=m.id OR pactaris.authority_area(target,m.id,x.subject_id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   IF f ? 'weekdays' AND x.weekdays IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(f->'weekdays')::smallint) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   UPDATE pactaris.authority_habits SET title=f->>'title',description=f->>'description',mode=f->>'mode',goal=(f->>'target')::integer,
    reward_points=(f->>'rewardPoints')::integer,penalty_points=(f->>'penaltyPoints')::integer,punishment=f->>'punishment',
    milestone_every=(f->>'milestoneEvery')::integer,milestone_points=(f->>'milestonePoints')::integer,version=version+1
    WHERE household_id=target AND id=x.id;
   resource=x.id;
  END IF;
 ELSIF action='habitState' THEN
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT (x.holder_id=m.id OR pactaris.authority_area(target,m.id,x.subject_id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='archived' OR payload->>'state'=x.state THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  -- Resuming starts at the current period; paused periods are never evaluated afterwards.
  UPDATE pactaris.authority_habits SET state=payload->>'state',version=version+1,
   skip_through=greatest(skip_through,pactaris.habit_period_start(period,time_zone,now())),
   next_period=CASE WHEN payload->>'state'='active' THEN pactaris.habit_period_start(period,time_zone,now()) ELSE next_period END
   WHERE household_id=target AND id=x.id;
  resource=x.id;
 ELSIF action IN ('habitBreakAdd','habitBreakCancel') THEN
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid AND state<>'archived' FOR UPDATE;
  IF NOT FOUND OR m.id NOT IN (x.subject_id,x.holder_id) OR (m.id=x.holder_id AND NOT pactaris.authority_area(target,m.id,x.subject_id,'tasks')) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF action='habitBreakAdd' THEN
   IF (payload->>'start')::date<(now() AT TIME ZONE x.time_zone)::date OR (payload->>'end')::date<(payload->>'start')::date
    OR (payload->>'end')::date>(now() AT TIME ZONE x.time_zone)::date+730 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
   IF jsonb_array_length(x.breaks)>=100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
   UPDATE pactaris.authority_habits SET breaks=breaks||jsonb_build_array(jsonb_build_object('id',operation,'start',payload->>'start','end',payload->>'end','creator',m.id)),version=version+1 WHERE household_id=target AND id=x.id;
   resource=operation;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x.breaks) b WHERE b->>'id'=payload->>'breakId'
    AND (b->>'end')::date>=(now() AT TIME ZONE x.time_zone)::date AND (m.id=x.subject_id OR b->>'creator'=m.id::text)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   UPDATE pactaris.authority_habits SET skip_through=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(x.breaks) b WHERE b->>'id'=payload->>'breakId' AND (b->>'start')::date<=(now() AT TIME ZONE x.time_zone)::date) THEN greatest(skip_through,pactaris.habit_period_start(period,time_zone,now())) ELSE skip_through END, breaks=(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(x.breaks) b WHERE b->>'id'<>payload->>'breakId'),version=version+1 WHERE household_id=target AND id=x.id;
   resource=(payload->>'breakId')::uuid;
  END IF;
 ELSIF action='habitRecord' THEN
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid AND state='active';
  IF NOT FOUND OR m.id NOT IN (x.subject_id,x.holder_id) OR NOT pactaris.authority_area(target,x.holder_id,x.subject_id,'tasks') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.authority_pairs p JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.paused WHERE p.household_id=target AND p.holder_id=x.holder_id AND p.subject_id=x.subject_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF pactaris.habit_break_overlap(x.breaks,pactaris.habit_period_start(x.period,x.time_zone,now()),pactaris.habit_period_start(x.period,x.time_zone,now())+CASE WHEN x.period='weekly' THEN 6 ELSE 0 END) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF x.period='daily' AND NOT extract(isodow from (now() AT TIME ZONE x.time_zone))::integer=ANY(x.weekdays) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF h.status<>'active' OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id IN (x.subject_id,x.holder_id) AND safety_paused) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  INSERT INTO pactaris.authority_habit_entries(household_id,id,habit_id,member_id,occurred_at,count) VALUES(target,operation,x.id,m.id,statement_timestamp(),(payload->>'count')::integer);
  resource=operation;
 ELSE
  SELECT * INTO e FROM pactaris.authority_habit_entries WHERE household_id=target AND id=(payload->>'entryId')::uuid FOR UPDATE;
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=e.habit_id;
  IF e.id IS NULL OR m.id NOT IN (e.member_id,x.holder_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF e.reversed OR pactaris.habit_period_start(x.period,x.time_zone,e.occurred_at)<x.next_period THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.authority_habit_entries SET reversed=true WHERE household_id=target AND id=e.id;
  resource=e.id;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_habit_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
