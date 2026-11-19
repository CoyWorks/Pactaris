CREATE TABLE pactaris.reward_redemptions (
 household_id uuid NOT NULL,id uuid NOT NULL,issuer_id uuid NOT NULL,recipient_id uuid NOT NULL,
 agreement_id uuid NOT NULL,agreement_version bigint NOT NULL,household_epoch bigint NOT NULL,
 item_id uuid NOT NULL,item_version bigint NOT NULL,terms jsonb NOT NULL,points integer NOT NULL CHECK(points BETWEEN 0 AND 1000000),
 state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','requested','fulfilled','declined','cancelled','reversed')),
 version bigint NOT NULL DEFAULT 1,expires_at timestamptz NOT NULL,
 PRIMARY KEY(household_id,id),CHECK(issuer_id<>recipient_id),
 FOREIGN KEY(household_id,item_id,item_version) REFERENCES pactaris.catalog_versions(household_id,item_id,version),
 FOREIGN KEY(household_id,agreement_id,agreement_version) REFERENCES pactaris.agreement_versions(household_id,agreement_id,version),
 FOREIGN KEY(household_id,issuer_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,recipient_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX reward_redemptions_recipient ON pactaris.reward_redemptions(household_id,recipient_id,id);
CREATE INDEX reward_redemptions_issuer ON pactaris.reward_redemptions(household_id,issuer_id,id);
CREATE TABLE pactaris.reward_point_entries (
 household_id uuid NOT NULL,redemption_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('debit','reversal')),
 operation_id uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,redemption_id,kind),
 FOREIGN KEY(household_id,redemption_id) REFERENCES pactaris.reward_redemptions(household_id,id)
);
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['reward_redemptions','reward_point_entries'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',table_name);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.available_reward_points(target uuid,instance uuid,actor uuid,member uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE earned bigint; spent bigint; reserved bigint; entry pactaris.reward_redemptions;
BEGIN
 SELECT coalesce(sum(g.points),0) INTO earned FROM pactaris.task_points g
  WHERE g.household_id=target AND g.recipient=member AND NOT EXISTS(SELECT 1 FROM pactaris.task_point_reversals x
   WHERE x.household_id=g.household_id AND x.task_id=g.task_id);
 SELECT coalesce(sum(r.points),0) INTO spent FROM pactaris.reward_redemptions r
  JOIN pactaris.reward_point_entries e ON e.household_id=r.household_id AND e.redemption_id=r.id AND e.kind='debit'
  WHERE r.household_id=target AND r.recipient_id=member AND NOT EXISTS(SELECT 1 FROM pactaris.reward_point_entries x
   WHERE x.household_id=e.household_id AND x.redemption_id=e.redemption_id AND x.kind='reversal');
 reserved=0;
 FOR entry IN SELECT * FROM pactaris.reward_redemptions WHERE household_id=target AND recipient_id=member AND state='requested' AND expires_at>now() LOOP
  IF pactaris.activity_guard(target,instance,actor,member,entry.agreement_id,entry.agreement_version,'reward',entry.household_epoch) THEN
   reserved=reserved+entry.points;
  END IF;
 END LOOP;
 RETURN earned-spent-reserved;
END $$;
REVOKE ALL ON FUNCTION pactaris.available_reward_points(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.reward_redemption_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; r pactaris.reward_redemptions; saved pactaris.catalog_receipts;
 opt record; options jsonb:='[]'; rows jsonb; response jsonb; item_terms jsonb; next_id uuid;
 next_state text; redemption_id uuid; cost integer; agreed_expiry timestamptz; other_member uuid;
BEGIN
 IF action IS NULL OR action NOT IN ('redemptionOptions','redemptionList','redemptionOffer','redemptionRequest','redemptionFulfill',
   'redemptionDecline','redemptionCancel','redemptionReverse') OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.catalog.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
 response=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed');
 IF action='redemptionOptions' THEN
  FOR opt IN SELECT a.id,a.version,rel.label,p.membership_id,other.display_name
   FROM pactaris.agreements a JOIN pactaris.agreement_versions v ON v.household_id=a.household_id AND v.agreement_id=a.id AND v.version=a.version
   JOIN pactaris.relationships rel ON rel.household_id=a.household_id AND rel.id=a.relationship_id AND rel.status='active'
   JOIN pactaris.relationship_participants own ON own.household_id=rel.household_id AND own.relationship_id=rel.id AND own.membership_id=m.id
   JOIN pactaris.relationship_participants p ON p.household_id=rel.household_id AND p.relationship_id=rel.id AND p.membership_id<>m.id
   JOIN pactaris.memberships other ON other.household_id=p.household_id AND other.id=p.membership_id AND other.status='active'
   WHERE a.household_id=target AND v.terms->'activities'?'reward' AND v.expires_at>now() AND NOT v.revoked
    AND pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,'reward',h.safety_version)
    AND (body->>'after' IS NULL OR (a.id,p.membership_id)>(split_part(body->>'after',':',1)::uuid,split_part(body->>'after',':',2)::uuid))
   ORDER BY a.id,p.membership_id LIMIT 11
  LOOP
   options=options||jsonb_build_array(jsonb_build_object('agreementId',opt.id,'version',opt.version::text,'label',opt.label,
    'memberId',opt.membership_id,'memberName',coalesce(opt.display_name,'')));
  END LOOP;
  RETURN response||jsonb_build_object('rewardOptions',CASE WHEN jsonb_array_length(options)=11 THEN options-10 ELSE options END,
   'nextCursor',CASE WHEN jsonb_array_length(options)=11 THEN (options->9->>'agreementId')||':'||(options->9->>'memberId') END);
 END IF;
 IF action='redemptionList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('redemptionId',v.id,'version',v.version::text,'state',
   CASE WHEN v.expires_at<=now() AND v.state IN ('offered','requested') THEN 'expired' ELSE v.state END,
   'role',CASE WHEN v.issuer_id=m.id THEN 'issuer' ELSE 'recipient' END,'title',v.terms->>'title',
   'description',v.terms->>'description','points',v.points) ORDER BY v.id),'[]') INTO rows
   FROM (SELECT * FROM pactaris.reward_redemptions WHERE household_id=target AND m.id IN (issuer_id,recipient_id)
    AND (body->>'after' IS NULL OR id>(body->>'after')::uuid) ORDER BY id LIMIT 11) v;
  IF jsonb_array_length(rows)=11 THEN next_id=(rows->9->>'redemptionId')::uuid;rows=rows-10;END IF;
  RETURN response||jsonb_build_object('redemptions',rows,'nextCursor',next_id);
 END IF;
 SELECT * INTO saved FROM pactaris.catalog_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF saved.household_id<>target OR saved.actor_membership_id<>m.id OR saved.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';
  END IF;
  RETURN saved.result;
 END IF;
 IF action='redemptionOffer' THEN
  SELECT v.fields INTO item_terms FROM pactaris.catalog_items i JOIN pactaris.catalog_versions v
   ON v.household_id=i.household_id AND v.item_id=i.id AND v.version=i.version
   WHERE i.household_id=target AND i.id=(body->>'itemId')::uuid AND i.creator_membership_id=m.id
     AND i.version=(body->>'itemVersion')::bigint AND i.state='draft';
  IF item_terms IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
  cost=(item_terms->>'points')::integer;
  IF cost IS NULL OR (cost>0 AND NOT h.points_enabled) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
  SELECT v.expires_at,p.membership_id INTO agreed_expiry,other_member
   FROM pactaris.agreements a JOIN pactaris.agreement_versions v ON v.household_id=a.household_id AND v.agreement_id=a.id AND v.version=a.version
   JOIN pactaris.relationship_participants p ON p.household_id=a.household_id AND p.relationship_id=a.relationship_id
   JOIN pactaris.memberships x ON x.household_id=p.household_id AND x.id=p.membership_id AND x.status='active'
   WHERE a.household_id=target AND a.id=(body->>'agreementId')::uuid AND a.version=(body->>'agreementVersion')::bigint
    AND p.membership_id=(body->>'recipientId')::uuid AND p.membership_id<>m.id;
  IF other_member IS NULL OR NOT pactaris.activity_guard(target,instance,actor,m.id,(body->>'agreementId')::uuid,
   (body->>'agreementVersion')::bigint,'reward',h.safety_version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
  IF (SELECT count(*) FROM pactaris.reward_redemptions WHERE household_id=target AND issuer_id=m.id
      AND state IN ('offered','requested') AND expires_at>now())>=25 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
  INSERT INTO pactaris.reward_redemptions(household_id,id,issuer_id,recipient_id,agreement_id,agreement_version,household_epoch,item_id,item_version,terms,points,expires_at)
   VALUES(target,operation,m.id,other_member,(body->>'agreementId')::uuid,(body->>'agreementVersion')::bigint,h.safety_version,
    (body->>'itemId')::uuid,(body->>'itemVersion')::bigint,item_terms,cost,least(agreed_expiry,now()+interval '7 days'));
  redemption_id=operation;
 ELSE
  SELECT * INTO r FROM pactaris.reward_redemptions WHERE household_id=target AND id=(body->>'redemptionId')::uuid AND m.id IN (issuer_id,recipient_id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
  IF r.version::text IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
  next_state=CASE
   WHEN action='redemptionRequest' AND r.state='offered' AND m.id=r.recipient_id THEN 'requested'
   WHEN action='redemptionFulfill' AND r.state='requested' AND m.id=r.issuer_id THEN 'fulfilled'
   WHEN action='redemptionDecline' AND ((r.state='offered' AND m.id=r.recipient_id) OR (r.state='requested' AND m.id=r.issuer_id)) THEN 'declined'
   WHEN action='redemptionCancel' AND r.state IN ('offered','requested') THEN 'cancelled'
   WHEN action='redemptionReverse' AND r.state='fulfilled' AND m.id=r.issuer_id THEN 'reversed'
  END;
  IF next_state IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
  IF next_state IN ('requested','fulfilled') AND (r.expires_at<=now()
   OR NOT pactaris.activity_guard(target,instance,actor,m.id,r.agreement_id,r.agreement_version,'reward',r.household_epoch)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';
  END IF;
  IF next_state='requested' AND r.points>0 AND pactaris.available_reward_points(target,instance,actor,m.id)<r.points THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';
  END IF;
  IF next_state='fulfilled' THEN
   -- The current reservation is already subtracted from the recipient's available balance.
   SELECT account_id INTO other_member FROM pactaris.memberships WHERE household_id=target AND id=r.recipient_id AND status='active';
   IF other_member IS NULL OR (r.points>0 AND pactaris.available_reward_points(target,instance,other_member,r.recipient_id)<0) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';
   END IF;
  END IF;
  IF next_state IN ('fulfilled','reversed') THEN
   INSERT INTO pactaris.reward_point_entries(household_id,redemption_id,kind,operation_id)
    VALUES(target,r.id,CASE WHEN next_state='fulfilled' THEN 'debit' ELSE 'reversal' END,operation);
  END IF;
  UPDATE pactaris.reward_redemptions SET state=next_state,version=version+1 WHERE household_id=target AND id=r.id;
  redemption_id=r.id;
 END IF;
 response=response||jsonb_build_object('status','applied');
 INSERT INTO pactaris.catalog_receipts VALUES(operation,target,m.id,fingerprint,response);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'catalog.'||action,redemption_id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.catalog_outbox VALUES(operation,target,'catalog.'||action,now());
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION pactaris.reward_redemption_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

CREATE FUNCTION pactaris.reward_balance(target uuid,instance uuid,actor uuid,member uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 IF NOT EXISTS(SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.id=target AND h.instance_id=instance AND h.status<>'closed' AND m.id=member AND m.account_id=actor AND m.status='active') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';
 END IF;
 RETURN greatest(0,pactaris.available_reward_points(target,instance,actor,member))::text;
END $$;
REVOKE ALL ON FUNCTION pactaris.reward_balance(uuid,uuid,uuid,uuid) FROM PUBLIC;
