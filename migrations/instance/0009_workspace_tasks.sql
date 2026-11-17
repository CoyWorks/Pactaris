ALTER TABLE pactaris.households ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC',ADD COLUMN settings_version bigint NOT NULL DEFAULT 1;
CREATE TABLE pactaris.tasks (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_membership_id uuid NOT NULL,assignee_membership_id uuid,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '' CHECK(char_length(description)<=1000),
 priority text NOT NULL CHECK(priority IN ('low','normal','high')),due_at timestamptz,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','done','archived')),version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,creator_membership_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,assignee_membership_id) REFERENCES pactaris.memberships(household_id,id),
 CHECK(assignee_membership_id IS NULL OR assignee_membership_id=creator_membership_id)
);
CREATE INDEX tasks_creator_page ON pactaris.tasks(household_id,creator_membership_id,state,id);
CREATE TABLE pactaris.workspace_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.workspace_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.workspace_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['tasks','workspace_receipts','workspace_outbox'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;
-- Initial pilot capacity, never replacing an existing operator entitlement.
UPDATE pactaris.household_entitlements SET capabilities=capabilities||'{"tasks.active.max":25}'::jsonb,version=version+1 WHERE NOT capabilities?'tasks.active.max';
CREATE FUNCTION pactaris.task_default_capacity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN IF NOT NEW.capabilities?'tasks.active.max' THEN NEW.capabilities=NEW.capabilities||'{"tasks.active.max":25}'::jsonb; END IF; RETURN NEW; END $$;
CREATE TRIGGER task_default_capacity BEFORE INSERT ON pactaris.household_entitlements FOR EACH ROW EXECUTE FUNCTION pactaris.task_default_capacity();
CREATE FUNCTION pactaris.task_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN UPDATE pactaris.tasks SET state='archived',assignee_membership_id=NULL,version=version+1,updated_at=statement_timestamp()
  WHERE household_id=NEW.household_id AND creator_membership_id=NEW.id AND state='open'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER task_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.task_departure();
REVOKE ALL ON FUNCTION pactaris.task_departure() FROM PUBLIC;
CREATE FUNCTION pactaris.workspace_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;t pactaris.tasks;receipt pactaris.workspace_receipts;
 answer jsonb;items jsonb;fields jsonb;cap integer;usage bigint;assign uuid;next_id uuid;needs_safety boolean:=false;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('workspaceRead','settingsUpdate','taskRead','taskCreate','taskUpdate','taskComplete','taskArchive','taskReopen') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.workspace.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied';END IF;
 SELECT * INTO receipt FROM pactaris.workspace_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;RETURN receipt.result;
 END IF;
 IF action='workspaceRead' THEN
  IF body->>'filter' IS NULL OR body->>'filter' NOT IN ('open','done','archived') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',v.id,'title',v.title,'priority',v.priority,'dueAt',v.due_at,'state',v.state,'version',v.version::text,
   'assignment',CASE WHEN v.assignee_membership_id IS NULL THEN 'unassigned' ELSE 'self' END) ORDER BY v.id),'[]'::jsonb) INTO items
   FROM (SELECT * FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=m.id AND state=body->>'filter' AND (body->>'after' IS NULL OR id>(body->>'after')::uuid) ORDER BY id LIMIT 10) v;
  IF jsonb_array_length(items)=10 AND EXISTS(SELECT 1 FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=m.id AND state=body->>'filter' AND id>(items->9->>'taskId')::uuid) THEN next_id=(items->9->>'taskId')::uuid;END IF;
  SELECT jsonb_build_object('open',count(*) FILTER(WHERE state='open'),'done',count(*) FILTER(WHERE state='done'),
   'unassigned',count(*) FILTER(WHERE state='open' AND assignee_membership_id IS NULL),'overdue',count(*) FILTER(WHERE state='open' AND due_at<now())) INTO answer
   FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=m.id;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','tasks',items,'nextCursor',next_id,'counts',answer,
   'household',jsonb_build_object('name',h.display_name,'timeZone',h.time_zone,'version',h.settings_version::text,'canEdit',m.technical_role IN ('owner','admin'),'status',h.status,
    'epoch',h.safety_version::text,'memberEpoch',m.safety_epoch::text,'selfPaused',m.safety_paused,'memberCount',(SELECT count(*) FROM pactaris.memberships WHERE household_id=target AND status='active')));
 ELSIF action='settingsUpdate' THEN
  IF m.technical_role NOT IN ('owner','admin') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied';END IF;
  IF h.settings_version::text IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;
  IF body->>'name' IS NULL OR char_length(body->>'name') NOT BETWEEN 1 AND 120 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=body->>'timeZone') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';END IF;
  UPDATE pactaris.households SET display_name=body->>'name',time_zone=body->>'timeZone',settings_version=settings_version+1 WHERE id=target;
 ELSE
  IF action<>'taskCreate' THEN
   SELECT * INTO t FROM pactaris.tasks WHERE household_id=target AND id=(body->>'taskId')::uuid AND creator_membership_id=m.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied';END IF;
   IF action='taskRead' THEN
    RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','task',jsonb_build_object('taskId',t.id,'title',t.title,'description',t.description,'priority',t.priority,'dueAt',t.due_at,'state',t.state,'version',t.version::text,'assignment',CASE WHEN t.assignee_membership_id IS NULL THEN 'unassigned' ELSE 'self' END));
   END IF;
   IF t.version::text IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;
  END IF;
  IF action IN ('taskCreate','taskReopen') THEN
   SELECT CASE WHEN capabilities->>'tasks.active.max'~'^[0-9]{1,6}$' THEN (capabilities->>'tasks.active.max')::int ELSE 0 END INTO cap FROM pactaris.household_entitlements WHERE household_id=target;
   SELECT count(*) INTO usage FROM pactaris.tasks WHERE household_id=target AND state='open';
   IF usage>=coalesce(cap,0) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.capacity';END IF;
  END IF;
  IF action IN ('taskCreate','taskUpdate') THEN
   fields=body->'fields';
   IF fields->>'assignment' IS NULL OR fields->>'assignment' NOT IN ('self','unassigned') OR fields->>'title' IS NULL OR char_length(fields->>'title') NOT BETWEEN 1 AND 120 OR fields->>'description' IS NULL OR char_length(fields->>'description')>1000 OR fields->>'priority' IS NULL OR fields->>'priority' NOT IN ('low','normal','high') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';END IF;
   assign=CASE WHEN fields->>'assignment'='self' THEN m.id ELSE NULL END;
   needs_safety=assign IS NOT NULL AND (action='taskCreate' OR t.assignee_membership_id IS NULL);
   IF action='taskUpdate' AND t.state<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;
  ELSIF action='taskComplete' THEN
   IF t.state<>'open' OR t.assignee_membership_id IS DISTINCT FROM m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;needs_safety=true;
  ELSIF action='taskArchive' THEN
   IF t.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;
  ELSIF action='taskReopen' THEN
   IF t.state='open' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';END IF;
  END IF;
  IF needs_safety AND (h.status<>'active' OR m.safety_paused OR h.safety_version::text IS DISTINCT FROM body->>'epoch' OR m.safety_epoch::text IS DISTINCT FROM body->>'memberEpoch' OR
   EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id AND limits->'blockedActivities'?'task')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.paused';END IF;
  IF action='taskCreate' THEN
   INSERT INTO pactaris.tasks(household_id,id,creator_membership_id,assignee_membership_id,title,description,priority,due_at)
    VALUES(target,operation,m.id,assign,fields->>'title',fields->>'description',fields->>'priority',(fields->>'dueAt')::timestamptz) RETURNING * INTO t;
  ELSE
   UPDATE pactaris.tasks SET title=CASE WHEN action='taskUpdate' THEN fields->>'title' ELSE title END,
    description=CASE WHEN action='taskUpdate' THEN fields->>'description' ELSE description END,priority=CASE WHEN action='taskUpdate' THEN fields->>'priority' ELSE priority END,
    due_at=CASE WHEN action='taskUpdate' THEN (fields->>'dueAt')::timestamptz ELSE due_at END,
    assignee_membership_id=CASE WHEN action='taskUpdate' THEN assign WHEN action='taskReopen' THEN NULL ELSE assignee_membership_id END,
    state=CASE WHEN action='taskComplete' THEN 'done' WHEN action='taskArchive' THEN 'archived' WHEN action='taskReopen' THEN 'open' ELSE state END,version=version+1,updated_at=statement_timestamp()
    WHERE household_id=target AND id=t.id RETURNING * INTO t;
  END IF;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied');IF t.id IS NOT NULL THEN answer=answer||jsonb_build_object('taskId',t.id);END IF;
 INSERT INTO pactaris.workspace_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'workspace.'||action,coalesce(t.id,target),jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.workspace_outbox VALUES(operation,target,'workspace.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
