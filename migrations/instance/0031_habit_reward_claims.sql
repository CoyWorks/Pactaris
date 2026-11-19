ALTER FUNCTION pactaris.reward_redemption_command(uuid,uuid,uuid,uuid,text,jsonb,text)
 RENAME TO reward_redemption_base;

CREATE FUNCTION pactaris.reward_redemption_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE redemption pactaris.reward_redemptions; member pactaris.memberships; household pactaris.households;
 receipt pactaris.catalog_receipts; answer jsonb; rules jsonb; period_start_at timestamptz; total bigint;
BEGIN
 IF action='redemptionOffer' AND body->'habitRequired'='true'::jsonb THEN
  answer=pactaris.reward_redemption_base(target,instance,actor,operation,action,body,fingerprint);
  UPDATE pactaris.reward_redemptions SET terms=terms||'{"habitRequired":true}'::jsonb
   WHERE household_id=target AND id=operation AND terms->>'kind'='grant';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid'; END IF;
  RETURN answer;
 END IF;
 IF action='redemptionList' THEN
  answer=pactaris.reward_redemption_base(target,instance,actor,operation,action,body,fingerprint);
  RETURN jsonb_set(answer,'{redemptions}',(
   SELECT coalesce(jsonb_agg(item.value||jsonb_build_object('habitRequired',coalesce(r.terms->'habitRequired','false')) ORDER BY item.ordinality),'[]')
   FROM jsonb_array_elements(answer->'redemptions') WITH ORDINALITY item
   JOIN pactaris.reward_redemptions r ON r.household_id=target AND r.id=(item.value->>'redemptionId')::uuid
  ));
 END IF;
 IF action NOT IN ('redemptionRequest','redemptionHabitClaim') OR action IS NULL THEN
  RETURN pactaris.reward_redemption_base(target,instance,actor,operation,action,body,fingerprint);
 END IF;

 IF operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.catalog.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));

 IF action='redemptionRequest' THEN
  IF EXISTS (SELECT 1 FROM pactaris.reward_redemptions r WHERE r.household_id=target
   AND r.id=(body->>'redemptionId')::uuid AND r.terms->'habitRequired'='true'::jsonb) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';
  END IF;
  RETURN pactaris.reward_redemption_base(target,instance,actor,operation,action,body,fingerprint);
 END IF;

 SELECT * INTO household FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO member FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF household.id IS NULL OR member.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.catalog_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>member.id OR receipt.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';
  END IF;
  RETURN receipt.result;
 END IF;
 SELECT * INTO redemption FROM pactaris.reward_redemptions r
  WHERE r.household_id=target AND r.id=(body->>'redemptionId')::uuid AND r.recipient_id=member.id
   AND r.terms->>'kind'='grant' AND r.terms->'habitRequired'='true'::jsonb;
 IF redemption.id IS NULL OR NOT household.points_enabled OR redemption.expires_at<=now()
  OR NOT pactaris.activity_guard(target,instance,actor,member.id,redemption.agreement_id,redemption.agreement_version,'reward',redemption.household_epoch)
  OR EXISTS (SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=member.id AND limits->'blockedActivities'?'task') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';
 END IF;
 IF redemption.state<>'offered' OR redemption.version::text IS DISTINCT FROM body->>'version' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';
 END IF;

 SELECT v.fields INTO rules FROM pactaris.routines habit JOIN pactaris.routine_revisions v
  ON v.household_id=habit.household_id AND v.routine_id=habit.id AND v.revision=habit.revision
  WHERE habit.household_id=target AND habit.id=(body->>'routineId')::uuid AND habit.creator_membership_id=member.id
   AND habit.kind='habit' AND habit.state='active' AND habit.version::text=body->>'routineVersion'
   AND v.fields->>'mode'='minimum' AND v.fields->>'period' IN ('daily','weekly');
 IF rules IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied'; END IF;
 SELECT start_at INTO period_start_at FROM pactaris.routine_period(rules,(now() AT TIME ZONE (rules->>'timeZone'))::date);
 SELECT coalesce(sum(e.count),0) INTO total FROM pactaris.progress_events e JOIN pactaris.routines habit
  ON habit.household_id=e.household_id AND habit.id=e.routine_id AND habit.revision=e.revision
  WHERE e.household_id=target AND e.routine_id=(body->>'routineId')::uuid AND e.period_start=period_start_at
   AND e.kind='habit' AND e.reversed_at IS NULL;
 IF total<(rules->>'target')::integer THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.habitGoalPending';
 END IF;

 INSERT INTO pactaris.reward_point_entries(household_id,redemption_id,kind,operation_id) VALUES(target,redemption.id,'credit',operation);
 UPDATE pactaris.reward_redemptions SET state='fulfilled',version=version+1 WHERE household_id=target AND id=redemption.id;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',member.id,'status','applied');
 INSERT INTO pactaris.catalog_receipts VALUES(operation,target,member.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'catalog.redemptionHabitClaim',redemption.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.catalog_outbox VALUES(operation,target,'catalog.redemptionHabitClaim',now());
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.reward_redemption_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
