CREATE TABLE pactaris.partner_tasks (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_id uuid NOT NULL,assignee_id uuid NOT NULL,agreement_id uuid NOT NULL,agreement_version bigint NOT NULL,fields jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','accepted','in_progress','submitted','changes_requested','done','declined','cancelled')),
 PRIMARY KEY(household_id,id),CHECK(creator_id<>assignee_id),FOREIGN KEY(household_id,creator_id) REFERENCES pactaris.memberships(household_id,id),FOREIGN KEY(household_id,assignee_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,agreement_id,agreement_version) REFERENCES pactaris.agreement_versions(household_id,agreement_id,version)
);
CREATE TABLE pactaris.partner_events (
 household_id uuid NOT NULL,task_id uuid NOT NULL,version bigint NOT NULL,action text NOT NULL,actor_id uuid NOT NULL,note text NOT NULL DEFAULT '' CHECK(char_length(note)<=500),at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,task_id,version),FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id),FOREIGN KEY(household_id,actor_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.partner_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.partner_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.partner_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['partner_tasks','partner_events','partner_receipts','partner_outbox'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;
-- Concurrency fingerprint, not a bearer credential. The command still runs the
-- authoritative guard in the same locked transaction. decided_at fences renewals.
CREATE FUNCTION pactaris.partner_snapshot(target uuid,agreement uuid,revision bigint) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT md5(h.safety_version::text||coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.membership_id)::text FROM pactaris.agreement_decisions d WHERE d.household_id=target AND d.agreement_id=agreement AND d.version=revision),'[]')) FROM pactaris.households h WHERE h.id=target
$$;
REVOKE ALL ON FUNCTION pactaris.partner_snapshot(uuid,uuid,bigint) FROM PUBLIC;
-- One shared household capacity for private open tasks and nonterminal offers.
-- Old workspace commands retain their interface; this trigger adds the combined
-- transactional count without editing any previously applied migration.
CREATE FUNCTION pactaris.combined_task_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE cap integer;used bigint;key text;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  IF NEW.state<>'open' THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state='open' THEN RETURN NEW;END IF;END IF;key='workspace.capacity';
 ELSE
  IF NEW.state IN ('done','declined','cancelled') THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' THEN IF OLD.state NOT IN ('done','declined','cancelled') THEN RETURN NEW;END IF;END IF;key='partner.capacity';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||NEW.household_id::text,0));
 SELECT CASE WHEN capabilities->>'tasks.active.max'~'^[0-9]{1,6}$' THEN (capabilities->>'tasks.active.max')::int ELSE 0 END INTO cap FROM pactaris.household_entitlements WHERE household_id=NEW.household_id;
 SELECT (SELECT count(*) FROM pactaris.tasks WHERE household_id=NEW.household_id AND state='open')+(SELECT count(*) FROM pactaris.partner_tasks WHERE household_id=NEW.household_id AND state NOT IN ('done','declined','cancelled')) INTO used;
 IF used>=coalesce(cap,0) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=key;END IF;RETURN NEW;
END $$;
CREATE TRIGGER combined_task_capacity BEFORE INSERT OR UPDATE OF state ON pactaris.tasks FOR EACH ROW EXECUTE FUNCTION pactaris.combined_task_capacity();
CREATE TRIGGER combined_partner_capacity BEFORE INSERT OR UPDATE OF state ON pactaris.partner_tasks FOR EACH ROW EXECUTE FUNCTION pactaris.combined_task_capacity();
REVOKE ALL ON FUNCTION pactaris.combined_task_capacity() FROM PUBLIC;
CREATE FUNCTION pactaris.partner_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE item pactaris.partner_tasks;
BEGIN IF OLD.status='active' AND NEW.status<>'active' THEN
 FOR item IN UPDATE pactaris.partner_tasks SET state='cancelled',version=version+1 WHERE household_id=NEW.household_id AND NEW.id IN (creator_id,assignee_id) AND state NOT IN ('done','declined','cancelled') RETURNING * LOOP
  INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id) VALUES(item.household_id,item.id,item.version,'membershipEnded',NEW.id);
 END LOOP;
END IF;RETURN NEW;END $$;
CREATE TRIGGER partner_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.partner_departure();
REVOKE ALL ON FUNCTION pactaris.partner_departure() FROM PUBLIC;
CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;t pactaris.partner_tasks;receipt pactaris.partner_receipts;a pactaris.agreements;
 answer jsonb;items jsonb;events jsonb;next_id uuid;event_cursor text;new_state text;other_name text;f jsonb;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('partnerOptions','partnerList','partnerRead','partnerOffer','partnerAccept','partnerDecline','partnerStart','partnerSubmit','partnerApprove','partnerChanges','partnerCancel','partnerReopen') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
 SELECT * INTO receipt FROM pactaris.partner_receipts WHERE operation_id=operation;
 IF FOUND THEN IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;RETURN receipt.result;END IF;
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
 IF action='partnerOffer' THEN
  SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=(payload->>'agreementId')::uuid AND version=(payload->>'agreementVersion')::bigint;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships mem ON mem.household_id=p.household_id AND mem.id=p.membership_id WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND mem.id=(payload->>'assigneeId')::uuid AND mem.status='active' AND mem.id<>m.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,a.id,a.version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,'task',h.safety_version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
  f=payload->'fields';
  IF f->>'title' IS NULL OR char_length(f->>'title') NOT BETWEEN 1 AND 120 OR f->>'description' IS NULL OR char_length(f->>'description')>500 OR f->>'priority' IS NULL OR f->>'priority' NOT IN ('low','normal','high') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
  INSERT INTO pactaris.partner_tasks(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,fields) VALUES(target,operation,m.id,(payload->>'assigneeId')::uuid,a.id,a.version,f) RETURNING * INTO t;
 ELSE
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid AND m.id IN (creator_id,assignee_id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
  IF action='partnerRead' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('version',e.version::text,'action',e.action,'actorId',e.actor_id,'note',e.note,'at',e.at) ORDER BY e.version),'[]'::jsonb) INTO events FROM (SELECT * FROM pactaris.partner_events WHERE household_id=target AND task_id=t.id AND version>coalesce((payload->>'afterVersion')::bigint,0) ORDER BY version LIMIT 11) e;
   IF jsonb_array_length(events)=11 THEN event_cursor=events->9->>'version';events=events-10;END IF;
   SELECT display_name INTO other_name FROM pactaris.memberships WHERE household_id=target AND id=CASE WHEN t.creator_id=m.id THEN t.assignee_id ELSE t.creator_id END;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','task',t.fields||jsonb_build_object('taskId',t.id,'version',t.version::text,'state',t.state,'creatorId',t.creator_id,'assigneeId',t.assignee_id,'role',CASE WHEN t.creator_id=m.id THEN 'creator' ELSE 'assignee' END,'counterpart',other_name,'agreementId',t.agreement_id,'agreementVersion',t.agreement_version::text,'agreementLabel',(SELECT terms->>'label' FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=t.agreement_id AND version=t.agreement_version),'epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version),'eligible',pactaris.activity_guard(target,instance,actor,m.id,t.agreement_id,t.agreement_version,'task',h.safety_version),'events',events,'nextEventCursor',event_cursor));
  END IF;
  IF t.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
  IF action='partnerCancel' THEN
   IF t.state IN ('done','declined','cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;new_state='cancelled';
  ELSIF action='partnerDecline' THEN
   IF m.id<>t.assignee_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   IF t.state<>'offered' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;new_state='declined';
  ELSE
   IF (action IN ('partnerAccept','partnerStart','partnerSubmit') AND m.id<>t.assignee_id) OR (action IN ('partnerApprove','partnerChanges','partnerReopen') AND m.id<>t.creator_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied';END IF;
   IF (action='partnerAccept' AND t.state<>'offered') OR (action='partnerStart' AND t.state NOT IN ('accepted','changes_requested')) OR (action='partnerSubmit' AND t.state<>'in_progress') OR (action IN ('partnerApprove','partnerChanges') AND t.state<>'submitted') OR (action='partnerReopen' AND t.state<>'done') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';END IF;
   IF h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version) IS DISTINCT FROM payload->>'safetyVersion' OR NOT pactaris.activity_guard(target,instance,actor,m.id,t.agreement_id,t.agreement_version,'task',h.safety_version) OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id IN(t.creator_id,t.assignee_id) AND status<>'active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused';END IF;
   IF action IN ('partnerSubmit','partnerChanges') AND (payload->>'note' IS NULL OR char_length(payload->>'note') NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';END IF;
   new_state=CASE action WHEN 'partnerAccept' THEN 'accepted' WHEN 'partnerStart' THEN 'in_progress' WHEN 'partnerSubmit' THEN 'submitted' WHEN 'partnerApprove' THEN 'done' WHEN 'partnerChanges' THEN 'changes_requested' ELSE 'offered' END;
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
