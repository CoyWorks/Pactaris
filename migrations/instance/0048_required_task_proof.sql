-- Enforce required photo proof without changing historical migration checksums.
CREATE OR REPLACE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
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
   -- Required proof is checked inside the same transaction as submission and the approval round.
   -- A failed check rolls back the task, receipt, audit and outbox written by the previous layer.
   IF t.fields->'proofRequired' = 'true'::jsonb AND NOT EXISTS (
    SELECT 1 FROM pactaris.task_proofs p WHERE p.household_id=target AND p.task_id=t.id
     AND p.author_id=t.assignee_id AND p.state='stored' AND p.round IS NULL
     AND p.file_present AND p.expires_at>now()
   ) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.proofRequired'; END IF;
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
