CREATE TABLE pactaris.shared_checkins (
 household_id uuid NOT NULL, id uuid NOT NULL, author_id uuid NOT NULL, reviewer_id uuid,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),
 response text CHECK(char_length(response) BETWEEN 1 AND 500),
 state text NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted','reviewed','withdrawn')),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,author_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,reviewer_id) REFERENCES pactaris.memberships(household_id,id),
 CHECK ((state='withdrawn')=(response IS NULL)),
 CHECK (reviewer_id IS NULL OR author_id<>reviewer_id)
);
CREATE INDEX shared_checkins_author ON pactaris.shared_checkins(household_id,author_id,id);
CREATE INDEX shared_checkins_reviewer ON pactaris.shared_checkins(household_id,reviewer_id,id);
ALTER TABLE pactaris.shared_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.shared_checkins FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.shared_checkins FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.shared_checkin_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;c pactaris.shared_checkins;prior pactaris.routine_receipts;
 reviewer uuid;answer jsonb;items jsonb;cursor uuid;
BEGIN
 IF action IS NULL OR action NOT IN ('checkinList','checkinSubmit','checkinReview','checkinWithdraw') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.routine.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied'; END IF;
 IF action='checkinList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'text',x.response,'version',x.version::text,'state',x.state,
   'mine',x.author_id=m.id,'shared',x.reviewer_id IS NOT NULL) ORDER BY x.id),'[]'::jsonb) INTO items
   FROM (SELECT z.* FROM pactaris.shared_checkins z WHERE z.household_id=target AND z.state<>'withdrawn'
    AND (z.author_id=m.id OR (z.reviewer_id=m.id AND EXISTS(SELECT 1 FROM pactaris.memberships
      WHERE household_id=target AND id=z.author_id AND status='active')))
    AND (payload->>'after' IS NULL OR z.id>(payload->>'after')::uuid) ORDER BY z.id LIMIT 11) x;
  IF jsonb_array_length(items)>10 THEN cursor=(items->9->>'id')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','checkins',items,'nextCursor',cursor);
 END IF;
 SELECT * INTO prior FROM pactaris.routine_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='checkinSubmit' THEN
  reviewer=(payload->>'reviewerId')::uuid;
  IF reviewer IS NOT NULL THEN
   IF reviewer=m.id OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=reviewer AND status='active') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied'; END IF;
   IF h.status<>'active' OR m.safety_paused OR EXISTS(SELECT 1 FROM pactaris.memberships
     WHERE household_id=target AND id=reviewer AND safety_paused) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.paused'; END IF;
  END IF;
  IF (SELECT count(*) FROM pactaris.shared_checkins WHERE household_id=target AND author_id=m.id AND state<>'withdrawn')>=25 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict'; END IF;
  INSERT INTO pactaris.shared_checkins(household_id,id,author_id,reviewer_id,title,response)
   VALUES(target,operation,m.id,reviewer,payload->>'title',payload->>'text') RETURNING * INTO c;
 ELSE
  SELECT * INTO c FROM pactaris.shared_checkins WHERE household_id=target AND id=(payload->>'checkinId')::uuid
   AND ((action='checkinWithdraw' AND author_id=m.id) OR (action='checkinReview' AND reviewer_id=m.id));
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.denied'; END IF;
  IF c.version::text IS DISTINCT FROM payload->>'version' OR c.state='withdrawn' OR (action='checkinReview' AND c.state<>'submitted') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.conflict'; END IF;
  IF action='checkinReview' AND (h.status<>'active' OR m.safety_paused OR NOT EXISTS(SELECT 1 FROM pactaris.memberships
    WHERE household_id=target AND id=c.author_id AND status='active' AND NOT safety_paused)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='routines.paused'; END IF;
  UPDATE pactaris.shared_checkins SET state=CASE WHEN action='checkinReview' THEN 'reviewed' ELSE 'withdrawn' END,
   response=CASE WHEN action='checkinWithdraw' THEN NULL ELSE response END,
   title=CASE WHEN action='checkinWithdraw' THEN id::text ELSE title END,version=version+1
   WHERE household_id=target AND id=c.id;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied');
 INSERT INTO pactaris.routine_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'routines.'||action,c.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.routine_outbox VALUES(operation,target,'routines.'||action,now());
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.shared_checkin_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
