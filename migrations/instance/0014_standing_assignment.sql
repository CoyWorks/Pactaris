-- Additive standing authority. No existing offer or agreement is converted.
CREATE TABLE pactaris.assignment_policies (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_id uuid NOT NULL,assignee_id uuid NOT NULL,agreement_id uuid NOT NULL,agreement_version bigint NOT NULL,
 version bigint NOT NULL DEFAULT 1,mode text NOT NULL CHECK(mode IN ('direct','explicit')),state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','active','revoked')),
 PRIMARY KEY(household_id,id),CHECK(creator_id<>assignee_id),
 FOREIGN KEY(household_id,creator_id) REFERENCES pactaris.memberships(household_id,id),FOREIGN KEY(household_id,assignee_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,agreement_id,agreement_version) REFERENCES pactaris.agreement_versions(household_id,agreement_id,version)
);
CREATE TABLE pactaris.assignment_policy_events (
 household_id uuid NOT NULL,policy_id uuid NOT NULL,version bigint NOT NULL,action text NOT NULL,actor_id uuid NOT NULL,at timestamptz NOT NULL,
 PRIMARY KEY(household_id,policy_id,version),FOREIGN KEY(household_id,policy_id) REFERENCES pactaris.assignment_policies(household_id,id),FOREIGN KEY(household_id,actor_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.assignment_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.assignment_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.assignment_policies FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
ALTER TABLE pactaris.assignment_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.assignment_policy_events FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.assignment_policy_events FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
ALTER TABLE pactaris.partner_tasks ADD COLUMN policy_id uuid,ADD COLUMN policy_version bigint,
 ADD FOREIGN KEY(household_id,policy_id) REFERENCES pactaris.assignment_policies(household_id,id),
 ADD CHECK((policy_id IS NULL)=(policy_version IS NULL));
ALTER TABLE pactaris.partner_tasks DROP CONSTRAINT partner_tasks_state_check;
ALTER TABLE pactaris.partner_tasks ADD CONSTRAINT partner_tasks_state_check CHECK(state IN ('assigned','offered','accepted','in_progress','submitted','changes_requested','done','declined','cancelled'));
CREATE FUNCTION pactaris.assignment_policy_current(target uuid,policy uuid,revision bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT policy IS NULL OR EXISTS(SELECT 1 FROM pactaris.assignment_policies WHERE household_id=target AND id=policy AND version=revision AND state='active')
$$;
REVOKE ALL ON FUNCTION pactaris.assignment_policy_current(uuid,uuid,bigint) FROM PUBLIC;
-- Departure revokes grants against the exact ended membership, retaining history.
CREATE FUNCTION pactaris.assignment_policy_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE p pactaris.assignment_policies;
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  FOR p IN UPDATE pactaris.assignment_policies SET state='revoked',version=version+1 WHERE household_id=NEW.household_id AND NEW.id IN(creator_id,assignee_id) AND state<>'revoked' RETURNING * LOOP
   INSERT INTO pactaris.assignment_policy_events VALUES(p.household_id,p.id,p.version,'membershipEnded',NEW.id,now());
  END LOOP;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.assignment_policy_departure() FROM PUBLIC;
CREATE TRIGGER assignment_policy_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.assignment_policy_departure();
CREATE OR REPLACE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
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
  IF payload->>'filter' IS NULL OR payload->>'filter' NOT IN ('active','closed') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
  SELECT coalesce(jsonb_agg(x.fields||jsonb_build_object('taskId',x.id,'version',x.version::text,'state',x.state,'creatorId',x.creator_id,'assigneeId',x.assignee_id,'role',CASE WHEN x.creator_id=m.id THEN 'creator' ELSE 'assignee' END,'counterpart',x.counterpart) ORDER BY x.id),'[]'::jsonb) INTO items
   FROM (SELECT p.*,mem.display_name AS counterpart FROM pactaris.partner_tasks p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=CASE WHEN p.creator_id=m.id THEN p.assignee_id ELSE p.creator_id END
    WHERE p.household_id=target AND m.id IN(p.creator_id,p.assignee_id) AND (CASE WHEN payload->>'filter'='closed' THEN p.state IN ('done','declined','cancelled') ELSE p.state NOT IN ('done','declined','cancelled') END) AND (payload->>'after' IS NULL OR p.id>(payload->>'after')::uuid) ORDER BY p.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_id=(items->9->>'taskId')::uuid;items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','tasks',items,'nextCursor',next_id);
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
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','task',t.fields||jsonb_build_object('taskId',t.id,'version',t.version::text,'state',t.state,'creatorId',t.creator_id,'assigneeId',t.assignee_id,'role',CASE WHEN t.creator_id=m.id THEN 'creator' ELSE 'assignee' END,'counterpart',other_name,'agreementId',t.agreement_id,'agreementVersion',t.agreement_version::text,'agreementLabel',(SELECT terms->>'label' FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=t.agreement_id AND version=t.agreement_version),'epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version),'assignmentMode',coalesce((SELECT mode FROM pactaris.assignment_policies WHERE household_id=target AND id=t.policy_id),'offer'),'policyVersion',t.policy_version::text,'eligible',pactaris.assignment_policy_current(target,t.policy_id,t.policy_version) AND pactaris.activity_guard(target,instance,actor,m.id,t.agreement_id,t.agreement_version,'task',h.safety_version),'events',events,'nextEventCursor',event_cursor));
  END IF;
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
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
