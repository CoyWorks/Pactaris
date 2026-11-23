-- Preserve saved routine revisions and add optional daily habit weekdays.
CREATE OR REPLACE FUNCTION pactaris.routine_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;r pactaris.routines;v pactaris.routine_revisions;receipt pactaris.routine_receipts;e pactaris.progress_events;
 answer jsonb;items jsonb;f jsonb;entry jsonb;next_id uuid;chosen_day date;bounds record;event_time timestamptz;total bigint;rev bigint;code text;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('routineList','routineRead','routineCreate','routineUpdate','routineActivate','routinePause','routineArchive','routineRestore','progressRecord','progressReverse') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.routine.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied';END IF;
 SELECT * INTO receipt FROM pactaris.routine_receipts WHERE operation_id=operation;
 IF FOUND THEN IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;RETURN receipt.result;END IF;
 IF action='routineList' THEN
  IF payload->>'kind' IS NULL OR payload->>'kind' NOT IN ('habit','ritual','checkin') OR payload->>'filter' IS NULL OR payload->>'filter' NOT IN ('current','archived') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('routineId',x.id,'kind',x.kind,'version',x.version::text,'revision',x.revision::text,'state',x.state,'title',x.fields->>'title','category',x.fields->>'category',
    'timeZone',x.fields->>'timeZone','weekdays',coalesce(x.fields->'weekdays','[1,2,3,4,5,6,7]'::jsonb),'period',x.fields->>'period','mode',x.fields->>'mode','target',(x.fields->>'target')::int) ORDER BY x.id),'[]'::jsonb) INTO items
   FROM (SELECT def.*,config.fields FROM pactaris.routines def JOIN pactaris.routine_revisions config ON config.household_id=def.household_id AND config.routine_id=def.id AND config.revision=def.revision
    WHERE def.household_id=target AND def.creator_membership_id=m.id AND def.kind=payload->>'kind' AND (CASE WHEN payload->>'filter'='archived' THEN def.state='archived' ELSE def.state<>'archived' END)
     AND (payload->>'after' IS NULL OR def.id>(payload->>'after')::uuid) ORDER BY def.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'routineId')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','routines',items,'nextCursor',next_id);
 END IF;
 IF action='routineCreate' THEN
  IF payload->>'kind' IS NULL OR payload->>'kind' NOT IN ('habit','ritual','checkin') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  INSERT INTO pactaris.routines(household_id,id,creator_membership_id,kind) VALUES(target,operation,m.id,payload->>'kind') RETURNING * INTO r;
 ELSE
  SELECT * INTO r FROM pactaris.routines WHERE household_id=target AND id=(payload->>'routineId')::uuid AND creator_membership_id=m.id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied';END IF;
  IF action NOT IN ('routineRead','progressReverse') AND r.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;
  rev=CASE WHEN action='routineRead' THEN coalesce((payload->>'revision')::bigint,r.revision) ELSE r.revision END;
  SELECT * INTO v FROM pactaris.routine_revisions WHERE household_id=target AND routine_id=r.id AND revision=rev;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied';END IF;f=v.fields;
 END IF;
 IF action IN ('routineCreate','routineUpdate') THEN
  f=payload->'fields';
  IF f->>'title' IS NULL OR char_length(f->>'title') NOT BETWEEN 1 AND 120 OR f->>'description' IS NULL OR char_length(f->>'description')>500 OR f->>'category' IS NULL OR char_length(f->>'category')>60 OR
   NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=f->>'timeZone') OR f->>'period' IS NULL OR f->>'period' NOT IN ('daily','weekly','once') OR f->>'mode' IS NULL OR f->>'mode' NOT IN ('minimum','maximum') OR
   (f->>'target')::int NOT BETWEEN 1 AND 10000 OR f->>'target' IS NULL OR f->>'responseType' IS NULL OR f->>'responseType' NOT IN ('text','rating','boolean') OR
   (f->>'period'='once' AND (f->>'date' IS NULL OR (f->>'date')::date NOT BETWEEN date '2000-01-01' AND date '2099-12-31')) OR
   (f->>'period'<>'once' AND f->>'date' IS NOT NULL) OR (r.kind='habit' AND f->>'period'='once') OR (r.kind<>'habit' AND ((f->>'target')::int<>1 OR f->>'mode'<>'minimum')) OR (r.kind='ritual' AND f->>'responseType'<>'boolean') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  IF action='routineUpdate' THEN
   IF r.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;
   UPDATE pactaris.routines SET revision=revision+1,version=version+1,state='draft' WHERE household_id=target AND id=r.id RETURNING * INTO r;
  END IF;
  INSERT INTO pactaris.routine_revisions(household_id,routine_id,revision,fields) VALUES(target,r.id,r.revision,f);
 ELSIF action='routineRead' THEN
  chosen_day=coalesce((payload->>'day')::date,(now() AT TIME ZONE (f->>'timeZone'))::date);
  SELECT * INTO bounds FROM pactaris.routine_period(f,chosen_day);
  SELECT coalesce(sum(count),0) INTO total FROM pactaris.progress_events WHERE household_id=target AND routine_id=r.id AND revision=rev AND period_start=bounds.start_at AND reversed_at IS NULL;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',x.id,'occurredAt',x.occurred_at,'count',x.count,'text',x.text,'rating',x.rating,'confirmed',x.confirmed,'reversed',x.reversed_at IS NOT NULL) ORDER BY x.id),'[]'::jsonb) INTO items
   FROM (SELECT * FROM pactaris.progress_events WHERE household_id=target AND routine_id=r.id AND revision=rev AND period_start=bounds.start_at AND (payload->>'after' IS NULL OR id>(payload->>'after')::uuid) ORDER BY id LIMIT 4) x;
  IF jsonb_array_length(items)=4 THEN next_id=(items->2->>'eventId')::uuid;items=items-3;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','routine',
   jsonb_build_object('routineId',r.id,'kind',r.kind,'version',r.version::text,'revision',rev::text,'state',r.state,'title',f->>'title','description',f->>'description','category',f->>'category','timeZone',f->>'timeZone',
    'weekdays',coalesce(f->'weekdays','[1,2,3,4,5,6,7]'::jsonb),'period',f->>'period','mode',f->>'mode','target',(f->>'target')::int,'date',f->>'date','responseType',f->>'responseType','historical',rev<>r.revision,'epoch',h.safety_version::text,'memberEpoch',m.safety_epoch::text,
    'periodDate',bounds.local_day::text,'periodStart',bounds.start_at,'periodEnd',bounds.end_at,'periodClosed',bounds.end_at<=now(),'periodTotal',total,
    'result',CASE WHEN f->>'mode'='maximum' THEN CASE WHEN total>(f->>'target')::int THEN 'over' ELSE 'within' END WHEN total>=(f->>'target')::int THEN 'reached' ELSE 'pending' END,'entries',items,'nextCursor',next_id));
 ELSIF action IN ('routineActivate','routinePause','routineArchive','routineRestore') THEN
  IF action='routineActivate' AND r.state NOT IN ('draft','paused') OR action='routinePause' AND r.state<>'active' OR action='routineArchive' AND r.state='archived' OR action='routineRestore' AND r.state<>'archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;
  IF action='routineActivate' AND r.kind<>'checkin' THEN
   code=CASE WHEN r.kind='habit' THEN 'task' ELSE 'protocol' END;
   IF h.status<>'active' OR m.safety_paused OR h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR m.safety_epoch::text IS DISTINCT FROM payload->>'memberEpoch' OR EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id AND limits->'blockedActivities'?code) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.paused';END IF;
  END IF;
  UPDATE pactaris.routines SET state=CASE WHEN action='routineActivate' THEN 'active' WHEN action='routinePause' THEN 'paused' WHEN action='routineArchive' THEN 'archived' ELSE 'draft' END,version=version+1 WHERE household_id=target AND id=r.id RETURNING * INTO r;
 ELSIF action='progressReverse' THEN
  SELECT * INTO e FROM pactaris.progress_events WHERE household_id=target AND routine_id=r.id AND id=(payload->>'eventId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied';END IF;
  UPDATE pactaris.progress_events SET reversed_at=coalesce(reversed_at,statement_timestamp()) WHERE household_id=target AND id=e.id;
 ELSIF action='progressRecord' THEN
  IF r.state<>'active' OR r.revision::text IS DISTINCT FROM payload->>'revision' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;
  IF r.kind<>'checkin' THEN
   code=CASE WHEN r.kind='habit' THEN 'task' ELSE 'protocol' END;
   IF h.status<>'active' OR m.safety_paused OR h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR m.safety_epoch::text IS DISTINCT FROM payload->>'memberEpoch' OR EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id AND limits->'blockedActivities'?code) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.paused';END IF;
  END IF;
  event_time=coalesce((payload->>'occurredAt')::timestamptz,now());
  IF r.kind='habit' AND f->>'period'='daily' AND NOT coalesce(f->'weekdays','[1,2,3,4,5,6,7]'::jsonb) @> to_jsonb(ARRAY[extract(isodow from (event_time AT TIME ZONE (f->>'timeZone')))::integer]) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.paused'; END IF;
  IF event_time>now() OR event_time<now()-interval '90 days' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  SELECT * INTO bounds FROM pactaris.routine_period(f,(event_time AT TIME ZONE (f->>'timeZone'))::date);
  IF event_time<bounds.start_at OR event_time>=bounds.end_at THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  entry=payload->'entry';
  IF entry->>'count' IS NULL OR (entry->>'count')::int NOT BETWEEN 1 AND 10000 OR entry->>'text' IS NULL OR char_length(entry->>'text')>500 OR
   (r.kind='habit' AND (entry->>'rating' IS NOT NULL OR entry->>'confirmed' IS NOT NULL)) OR
   (r.kind<>'habit' AND ((entry->>'count')::int<>1 OR (f->>'responseType'='rating' AND ((entry->>'rating')::int NOT BETWEEN 1 AND 5 OR entry->>'rating' IS NULL OR entry->>'confirmed' IS NOT NULL)) OR
    (f->>'responseType'='boolean' AND (entry->>'confirmed' IS NULL OR entry->>'rating' IS NOT NULL)) OR (f->>'responseType'='text' AND (entry->>'rating' IS NOT NULL OR entry->>'confirmed' IS NOT NULL)) OR (r.kind='ritual' AND (entry->>'confirmed')::boolean IS DISTINCT FROM true))) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';END IF;
  IF r.kind<>'habit' AND EXISTS(SELECT 1 FROM pactaris.progress_events WHERE household_id=target AND routine_id=r.id AND revision=r.revision AND period_start=bounds.start_at AND reversed_at IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict';END IF;
  INSERT INTO pactaris.progress_events(household_id,id,routine_id,revision,kind,occurred_at,period_start,count,text,rating,confirmed)
   VALUES(target,operation,r.id,r.revision,r.kind,event_time,bounds.start_at,(entry->>'count')::int,entry->>'text',(entry->>'rating')::int,(entry->>'confirmed')::boolean) RETURNING * INTO e;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','routineId',r.id);IF e.id IS NOT NULL THEN answer=answer||jsonb_build_object('eventId',e.id);END IF;
 INSERT INTO pactaris.routine_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'routines.'||action,r.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.routine_outbox VALUES(operation,target,'routines.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.routine_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
