-- Approval by several people and photo proof on the new rights model (owner decisions,
-- 21 November 2026; docs/HOUSEHOLD_AUTHORITY.md, docs/TASK_PROOF.md).
-- A submitted task opens an approval round: its creator plus every member who holds the `approve`
-- right over the assignee at that moment. The task is done once all of them approved. Any approver
-- may ask for changes; that ends the round (all approvals lapse) and the sub submits again.
ALTER TABLE pactaris.partner_tasks ADD COLUMN approval_round integer NOT NULL DEFAULT 0;
CREATE TABLE pactaris.task_approvals (
 household_id uuid NOT NULL,task_id uuid NOT NULL,round integer NOT NULL,approver_id uuid NOT NULL,
 decision text CHECK(decision IN ('approved','changes')),decided_at timestamptz,
 PRIMARY KEY(household_id,task_id,round,approver_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id),
 FOREIGN KEY(household_id,approver_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX task_approvals_pending ON pactaris.task_approvals(household_id,approver_id) WHERE decision IS NULL;
CREATE TABLE pactaris.approval_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
-- A proof is bound to the round it was submitted with; every approver of that round may see it once.
ALTER TABLE pactaris.task_proofs ADD COLUMN round integer;
CREATE TABLE pactaris.task_proof_views (
 household_id uuid NOT NULL,proof_id uuid NOT NULL,viewer_id uuid NOT NULL,viewed_at timestamptz,
 PRIMARY KEY(household_id,proof_id,viewer_id),
 FOREIGN KEY(household_id,proof_id) REFERENCES pactaris.task_proofs(household_id,id),
 FOREIGN KEY(household_id,viewer_id) REFERENCES pactaris.memberships(household_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['task_approvals','approval_receipts','task_proof_views'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;

-- Approvers of the current round with their decisions, for the task's parties and approvers.
CREATE FUNCTION pactaris.task_approval_state(target uuid,task uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',a.approver_id,'name',m.display_name,'decision',a.decision,'decidedAt',a.decided_at)
   ORDER BY a.approver_id=t.creator_id DESC,m.display_name,a.approver_id),'[]'::jsonb)
 FROM pactaris.partner_tasks t JOIN pactaris.task_approvals a ON a.household_id=t.household_id AND a.task_id=t.id AND a.round=t.approval_round
 JOIN pactaris.memberships m ON m.household_id=a.household_id AND m.id=a.approver_id
 WHERE t.household_id=target AND t.id=task
$$;
REVOKE ALL ON FUNCTION pactaris.task_approval_state(uuid,uuid) FROM PUBLIC;

-- The proof a member may see for a task right now: the author sees their latest proof, a viewer the
-- proof bound to the current round.
CREATE FUNCTION pactaris.task_proof_state(target uuid,task uuid,member uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT (SELECT jsonb_build_object('proofId',p.id,'type',p.type,'state',p.state,'bound',p.round IS NOT NULL,
   'available',p.state='stored' AND p.file_present AND p.expires_at>now() AND (p.author_id=member OR v.viewed_at IS NULL),
   'consumes',p.author_id<>member AND v.viewed_at IS NULL,'expiresAt',p.expires_at)
  FROM pactaris.task_proofs p JOIN pactaris.partner_tasks t ON t.household_id=p.household_id AND t.id=p.task_id
  LEFT JOIN pactaris.task_proof_views v ON v.household_id=p.household_id AND v.proof_id=p.id AND v.viewer_id=member
  WHERE p.household_id=target AND p.task_id=task AND p.state<>'removed'
   AND (p.author_id=member OR (v.viewer_id IS NOT NULL AND p.round=t.approval_round))
  ORDER BY p.created_at DESC LIMIT 1)
$$;
REVOKE ALL ON FUNCTION pactaris.task_proof_state(uuid,uuid,uuid) FROM PUBLIC;

ALTER FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) RENAME TO partner_command_before_approvals;
DO $$
DECLARE grantee text;
BEGIN
 FOR grantee IN SELECT rolname FROM pg_roles WHERE
  has_function_privilege(oid,'pactaris.partner_command_before_approvals(uuid,uuid,uuid,uuid,text,jsonb,text)','EXECUTE')
  AND rolname<>current_user AND NOT rolsuper LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION pactaris.partner_command_before_approvals(uuid,uuid,uuid,uuid,text,jsonb,text) FROM %I',grantee);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;c pactaris.memberships;t pactaris.partner_tasks;prior pactaris.approval_receipts;
 answer jsonb;base jsonb;fresh boolean;rnd integer;pending integer;pid uuid;items jsonb;approver uuid;
BEGIN
 IF action NOT IN ('approvalList','approvalRead','partnerSubmit','partnerApprove','partnerChanges','partnerRead') THEN
  RETURN pactaris.partner_command_before_approvals(target,instance,actor,operation,action,payload,fingerprint);
 END IF;
 IF action IN ('approvalList','approvalRead') THEN
  IF fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid'; END IF;
  SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
  SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
  IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
  IF action='approvalList' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',x.id,'version',x.version::text,'title',x.fields->>'title','assigneeId',x.assignee_id,
     'assigneeName',am.display_name,'creatorName',cm.display_name,'submittedAt',x.submitted_at) ORDER BY x.submitted_at,x.id),'[]'::jsonb) INTO items
    FROM (SELECT t2.*,(SELECT max(e.at) FROM pactaris.partner_events e WHERE e.household_id=t2.household_id AND e.task_id=t2.id AND e.action='partnerSubmit') AS submitted_at
     FROM pactaris.partner_tasks t2 JOIN pactaris.task_approvals a ON a.household_id=t2.household_id AND a.task_id=t2.id AND a.round=t2.approval_round
     WHERE t2.household_id=target AND t2.state='submitted' AND a.approver_id=m.id AND a.decision IS NULL ORDER BY t2.id LIMIT 25) x
    JOIN pactaris.memberships am ON am.household_id=x.household_id AND am.id=x.assignee_id
    JOIN pactaris.memberships cm ON cm.household_id=x.household_id AND cm.id=x.creator_id;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','approvals',items);
  END IF;
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid;
  IF NOT FOUND OR t.approval_round=0 OR NOT EXISTS(SELECT 1 FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND approver_id=m.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','approval',
   jsonb_build_object('taskId',t.id,'version',t.version::text,'state',t.state,'title',t.fields->>'title','description',coalesce(t.fields->>'description',''),
    'priority',t.fields->>'priority','dueAt',t.fields->'dueAt','assigneeId',t.assignee_id,'assigneeName',(SELECT display_name FROM pactaris.memberships WHERE household_id=target AND id=t.assignee_id),
    'creatorId',t.creator_id,'creatorName',(SELECT display_name FROM pactaris.memberships WHERE household_id=target AND id=t.creator_id),
    'note',coalesce((SELECT e.note FROM pactaris.partner_events e WHERE e.household_id=target AND e.task_id=t.id AND e.action='partnerSubmit' ORDER BY e.version DESC LIMIT 1),''),
    'epoch',h.safety_version::text,'safetyVersion',pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version),
    'canDecide',t.state='submitted' AND EXISTS(SELECT 1 FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND approver_id=m.id AND decision IS NULL),
    'approvals',pactaris.task_approval_state(target,t.id),'proof',pactaris.task_proof_state(target,t.id,m.id)));
 END IF;
 IF action='partnerSubmit' THEN
  fresh=NOT EXISTS(SELECT 1 FROM pactaris.partner_receipts WHERE operation_id=operation);
  base=pactaris.partner_command_before_approvals(target,instance,actor,operation,action,payload,fingerprint);
  IF fresh THEN
   SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(base->>'taskId')::uuid FOR UPDATE;
   rnd=t.approval_round+1;
   UPDATE pactaris.partner_tasks SET approval_round=rnd WHERE household_id=target AND id=t.id;
   INSERT INTO pactaris.task_approvals(household_id,task_id,round,approver_id) VALUES(target,t.id,rnd,t.creator_id);
   INSERT INTO pactaris.task_approvals(household_id,task_id,round,approver_id)
    SELECT target,t.id,rnd,o.id FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active' AND o.id NOT IN (t.creator_id,t.assignee_id)
     AND pactaris.authority_area(target,o.id,t.assignee_id,'approve');
   FOR approver IN SELECT approver_id FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=rnd AND approver_id<>t.creator_id LOOP
    PERFORM pactaris.notice(target,approver,t.assignee_id,'approval',t.id);
   END LOOP;
   -- Bind the latest unsubmitted proof to this round; each approver may view it once.
   SELECT id INTO pid FROM pactaris.task_proofs WHERE household_id=target AND task_id=t.id AND author_id=t.assignee_id AND state='stored' AND round IS NULL
    ORDER BY created_at DESC LIMIT 1;
   IF pid IS NOT NULL THEN
    UPDATE pactaris.task_proofs SET round=rnd,expires_at=now()+interval '48 hours' WHERE household_id=target AND id=pid;
    INSERT INTO pactaris.task_proof_views(household_id,proof_id,viewer_id) SELECT target,pid,approver_id FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=rnd;
   END IF;
  END IF;
  RETURN base;
 END IF;
 IF action='partnerRead' THEN
  base=pactaris.partner_command_before_approvals(target,instance,actor,operation,action,payload,fingerprint);
  RETURN jsonb_set(base,'{task}',(base->'task')||jsonb_build_object('approvals',pactaris.task_approval_state(target,(base->'task'->>'taskId')::uuid),
   'proof',pactaris.task_proof_state(target,(base->'task'->>'taskId')::uuid,(base->>'actorMembershipId')::uuid)));
 END IF;
 -- partnerApprove / partnerChanges
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO prior FROM pactaris.approval_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.request_hash<>fingerprint OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=prior.actor_membership_id AND account_id=actor) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict'; END IF;
  RETURN prior.result;
 END IF;
 SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid FOR UPDATE;
 -- Tasks submitted before approval rounds existed keep the creator-only path.
 IF NOT FOUND OR t.approval_round=0 THEN RETURN pactaris.partner_command_before_approvals(target,instance,actor,operation,action,payload,fingerprint); END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL OR NOT EXISTS(SELECT 1 FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND approver_id=m.id) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
 IF t.state<>'submitted' OR t.version::text IS DISTINCT FROM payload->>'version'
  OR EXISTS(SELECT 1 FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND approver_id=m.id AND decision IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict'; END IF;
 -- The right must still hold; pauses and stops win.
 IF m.id<>t.creator_id AND NOT pactaris.authority_area(target,m.id,t.assignee_id,'approve') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
 IF h.status<>'active' OR m.safety_paused OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=t.assignee_id AND safety_paused) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused'; END IF;
 IF h.safety_version::text IS DISTINCT FROM payload->>'epoch' OR pactaris.partner_snapshot(target,t.agreement_id,t.agreement_version) IS DISTINCT FROM payload->>'safetyVersion' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.paused'; END IF;
 IF action='partnerChanges' AND (payload->>'note' IS NULL OR char_length(payload->>'note') NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid'; END IF;
 SELECT * INTO c FROM pactaris.memberships WHERE household_id=target AND id=t.creator_id AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict'; END IF;
 UPDATE pactaris.task_approvals SET decision=CASE WHEN action='partnerApprove' THEN 'approved' ELSE 'changes' END,decided_at=now()
  WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND approver_id=m.id;
 SELECT count(*) INTO pending FROM pactaris.task_approvals WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND decision IS NULL;
 IF action='partnerApprove' AND pending>0 THEN
  -- One approval of several: recorded on the task's history; the task stays submitted.
  UPDATE pactaris.partner_tasks SET version=version+1 WHERE household_id=target AND id=t.id RETURNING * INTO t;
  INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,t.id,t.version,'partnerApproval',m.id,'');
  answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','taskId',t.id);
 ELSE
  -- The last approval completes the task, or one request for changes ends the round. The existing path
  -- runs on the creator's behalf so points, rewards and notices behave as before; history shows who did it.
  base=pactaris.partner_command_before_approvals(target,instance,c.account_id,operation,action,payload||jsonb_build_object('membershipId',c.id),fingerprint);
  UPDATE pactaris.partner_events SET actor_id=m.id WHERE household_id=target AND task_id=t.id
   AND version=(SELECT version FROM pactaris.partner_tasks WHERE household_id=target AND id=t.id);
  IF action='partnerChanges' THEN
   UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=target AND task_id=t.id AND round=t.approval_round AND state='stored';
  END IF;
  answer=base||jsonb_build_object('actorMembershipId',m.id);
 END IF;
 INSERT INTO pactaris.approval_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'partner.approval.'||action,t.id,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Proof command on the approval model: the author stores a proof before submitting; at submission it
-- is bound to the round and each approver may view it once. Bytes go once every approver has seen it,
-- when changes are requested, when it is removed, or 48 hours after submission (7 days unsubmitted).
CREATE OR REPLACE FUNCTION pactaris.proof_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;t pactaris.partner_tasks;p pactaris.task_proofs;v pactaris.task_proof_views;prior pactaris.proof_receipts;answer jsonb;rows jsonb;
BEGIN
 IF action IS NULL OR action NOT IN ('proofPut','proofHead','proofViewed','proofPurged','proofList','proofRemove') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.proof.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
 IF action='proofList' THEN
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed',
   'proof',pactaris.task_proof_state(target,(payload->>'taskId')::uuid,m.id));
 END IF;
 IF action='proofHead' THEN
  SELECT * INTO p FROM pactaris.task_proofs WHERE household_id=target AND id=(payload->>'proofId')::uuid;
  SELECT * INTO v FROM pactaris.task_proof_views WHERE household_id=target AND proof_id=p.id AND viewer_id=m.id;
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=p.task_id;
  IF p.id IS NULL OR NOT (p.author_id=m.id OR (v.viewer_id IS NOT NULL AND p.round=t.approval_round)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed',
   'proof',jsonb_build_object('proofId',p.id,'type',p.type,'size',p.size,'state',p.state,'role',CASE WHEN p.author_id=m.id THEN 'author' ELSE 'viewer' END,
    'available',p.state='stored' AND p.file_present AND p.expires_at>now() AND (p.author_id=m.id OR v.viewed_at IS NULL),
    'consumes',p.author_id<>m.id AND v.viewed_at IS NULL));
 END IF;
 SELECT * INTO prior FROM pactaris.proof_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='proofPut' THEN
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid;
  IF NOT FOUND OR t.assignee_id<>m.id OR t.state NOT IN ('assigned','accepted','in_progress','changes_requested') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.paused'; END IF;
  IF payload->>'type' NOT IN ('image/jpeg','image/png','image/webp') OR (payload->>'size')::integer NOT BETWEEN 1 AND 5242880 OR payload->>'sha256'!~'^[0-9a-f]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.invalid'; END IF;
  -- One unsubmitted proof per task: a new one replaces the previous (its file is purged by the sweep).
  UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=target AND task_id=t.id AND author_id=m.id AND state='stored' AND round IS NULL;
  INSERT INTO pactaris.task_proofs(household_id,id,task_id,author_id,viewer_id,type,size,sha256,expires_at)
   VALUES(target,operation,t.id,m.id,t.creator_id,payload->>'type',(payload->>'size')::integer,payload->>'sha256',now()+interval '7 days');
  answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',operation);
 ELSE
  SELECT * INTO p FROM pactaris.task_proofs WHERE household_id=target AND id=(payload->>'proofId')::uuid FOR UPDATE;
  SELECT * INTO v FROM pactaris.task_proof_views WHERE household_id=target AND proof_id=p.id AND viewer_id=m.id FOR UPDATE;
  IF p.id IS NULL OR NOT (p.author_id=m.id OR v.viewer_id IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  IF action='proofViewed' THEN
   -- Each approver's first full view counts; once all have seen it the bytes are deleted.
   IF v.viewer_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
   UPDATE pactaris.task_proof_views SET viewed_at=now() WHERE household_id=target AND proof_id=p.id AND viewer_id=m.id AND viewed_at IS NULL;
   IF p.state='stored' AND NOT EXISTS(SELECT 1 FROM pactaris.task_proof_views WHERE household_id=target AND proof_id=p.id AND viewed_at IS NULL) THEN
    UPDATE pactaris.task_proofs SET state='viewed',viewed_at=now() WHERE household_id=target AND id=p.id;
   END IF;
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id,
    'consumed',v.viewed_at IS NULL,'allViewed',NOT EXISTS(SELECT 1 FROM pactaris.task_proof_views WHERE household_id=target AND proof_id=p.id AND viewed_at IS NULL));
  ELSIF action='proofPurged' THEN
   UPDATE pactaris.task_proofs SET file_present=false WHERE household_id=target AND id=p.id AND state<>'stored';
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id);
  ELSE
   IF p.author_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
   UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=target AND id=p.id AND state IN ('stored','viewed');
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id);
  END IF;
 END IF;
 INSERT INTO pactaris.proof_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'proof.'||action,(answer->>'proofId')::uuid,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;

-- Departure or erasure of the author or any viewer removes the proof.
CREATE OR REPLACE FUNCTION pactaris.proof_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF (NEW.status<>'active' AND OLD.status='active') OR (NEW.account_erased_at IS NOT NULL AND OLD.account_erased_at IS NULL) THEN
  UPDATE pactaris.task_proofs p SET state='removed' WHERE p.household_id=NEW.household_id AND p.state IN ('stored','viewed')
   AND (p.author_id=NEW.id OR EXISTS(SELECT 1 FROM pactaris.task_proof_views v WHERE v.household_id=p.household_id AND v.proof_id=p.id AND v.viewer_id=NEW.id));
 END IF;
 RETURN NEW;
END $$;

-- A notice for approvers who are not the task's creator.
ALTER TABLE pactaris.member_notices DROP CONSTRAINT member_notices_kind_check,
 ADD CONSTRAINT member_notices_kind_check CHECK(kind IN ('permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer','approval'));
ALTER TABLE pactaris.notice_preferences DROP CONSTRAINT notice_preferences_muted_check,
 ADD CONSTRAINT notice_preferences_muted_check CHECK(muted <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer','approval']::text[]);
-- Identical to 0044_primary_dom_rights apart from the approval notice kind.
CREATE OR REPLACE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;chosen text[];
BEGIN
 IF action IS NULL OR action NOT IN ('noticeList','noticeRead','noticePreferences','noticeConfigure') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action IN ('noticePreferences','noticeConfigure') THEN
  IF action='noticeConfigure' THEN
   IF jsonb_typeof(payload->'muted')<>'array' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO chosen FROM jsonb_array_elements_text(payload->'muted') k;
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer','approval']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   INSERT INTO pactaris.notice_preferences(household_id,member_id,muted) VALUES(target,m.id,chosen)
    ON CONFLICT(household_id,member_id) DO UPDATE SET muted=EXCLUDED.muted,version=pactaris.notice_preferences.version+1;
  END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticePreferences' THEN 'listed' ELSE 'applied' END,
   'muted',to_jsonb(coalesce((SELECT muted FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::text[])));
 END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',a.display_name,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id ORDER BY push_seq DESC LIMIT 30) n
  LEFT JOIN pactaris.memberships a ON a.household_id=n.household_id AND a.id=n.actor_id;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread);
END $$;
