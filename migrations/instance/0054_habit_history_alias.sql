-- Avoid ambiguity with the command's progress-entry variable.
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
    'title',y.title,'description',y.description,'category',y.category,'breaks',y.breaks,'weekdays',to_jsonb(y.weekdays),'period',y.period,'mode',y.mode,'target',y.goal,'timeZone',y.time_zone,
    'rewardPoints',y.reward_points,'penaltyPoints',y.penalty_points,'punishment',y.punishment,'milestoneEvery',y.milestone_every,'milestonePoints',y.milestone_points,'streaks',pactaris.habit_streaks(target,y.id),'state',y.state,'version',y.version::text,
    'periodStart',pactaris.habit_period_start(y.period,y.time_zone,now()),
    'currentTotal',pactaris.habit_period_total(target,y.id,y.period,y.time_zone,pactaris.habit_period_start(y.period,y.time_zone,now())),
    'canEdit',y.holder_id=m.id OR pactaris.authority_area(target,m.id,y.subject_id,'manage'),'canPlanBreak',m.id=y.subject_id OR (m.id=y.holder_id AND pactaris.authority_area(target,m.id,y.subject_id,'tasks')),'canRecord',m.id IN (y.subject_id,y.holder_id) AND NOT pactaris.habit_break_overlap(y.breaks,pactaris.habit_period_start(y.period,y.time_zone,now()),pactaris.habit_period_start(y.period,y.time_zone,now())+CASE WHEN y.period='weekly' THEN 6 ELSE 0 END) AND (y.period<>'daily' OR extract(isodow from (now() AT TIME ZONE y.time_zone))::integer=ANY(y.weekdays)),
    'entries',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',entry_row.id,'occurredAt',entry_row.occurred_at,'count',entry_row.count,'reversed',entry_row.reversed,'canReverse',NOT entry_row.reversed AND m.id IN (entry_row.member_id,y.holder_id) AND pactaris.habit_period_start(y.period,y.time_zone,entry_row.occurred_at)>=y.next_period) ORDER BY entry_row.occurred_at DESC),'[]'::jsonb) FROM (SELECT * FROM pactaris.authority_habit_entries WHERE household_id=target AND habit_id=y.id ORDER BY occurred_at DESC LIMIT 20) entry_row),
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
   INSERT INTO pactaris.authority_habits(household_id,id,holder_id,subject_id,title,description,category,period,mode,goal,time_zone,reward_points,penalty_points,punishment,milestone_every,milestone_points,weekdays,next_period)
    VALUES(target,operation,m.id,other.id,f->>'title',f->>'description',coalesce(f->>'category',''),f->>'period',f->>'mode',(f->>'target')::integer,zone,
     (f->>'rewardPoints')::integer,(f->>'penaltyPoints')::integer,f->>'punishment',(f->>'milestoneEvery')::integer,(f->>'milestonePoints')::integer,CASE WHEN f ? 'weekdays' THEN ARRAY(SELECT jsonb_array_elements_text(f->'weekdays')::smallint) ELSE ARRAY[1,2,3,4,5,6,7]::smallint[] END,pactaris.habit_period_start(f->>'period',zone,now()));
   resource=operation;
  ELSE
   SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid FOR UPDATE;
   IF NOT FOUND OR NOT (x.holder_id=m.id OR pactaris.authority_area(target,m.id,x.subject_id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   IF f ? 'weekdays' AND x.weekdays IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(f->'weekdays')::smallint) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   UPDATE pactaris.authority_habits SET title=f->>'title',description=f->>'description',category=coalesce(f->>'category',category),mode=f->>'mode',goal=(f->>'target')::integer,
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
