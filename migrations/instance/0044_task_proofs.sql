-- Photo proof of task completion (docs/TASK_PROOF.md). Metadata only; the encrypted, metadata-stripped
-- bytes live on the instance's own disk (ProofStore). A proof belongs to a shared task; only the task's
-- assignee (author) and creator (viewer) may see it. Once the viewer has seen it the bytes are deleted,
-- and in any case 48h after storage; the metadata row stays as a trail. A viewer screenshot cannot be
-- prevented and the UI says so.
CREATE TABLE pactaris.task_proofs (
 household_id uuid NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL,author_id uuid NOT NULL,viewer_id uuid NOT NULL,
 type text NOT NULL CHECK(type IN ('image/jpeg','image/png','image/webp')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'stored' CHECK(state IN ('stored','viewed','expired','removed')),
 file_present boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,viewed_at timestamptz,
 PRIMARY KEY(household_id,id),CHECK(author_id<>viewer_id),
 FOREIGN KEY(household_id,task_id) REFERENCES pactaris.partner_tasks(household_id,id),
 FOREIGN KEY(household_id,author_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,viewer_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX task_proofs_task ON pactaris.task_proofs(household_id,task_id);
CREATE INDEX task_proofs_purge ON pactaris.task_proofs(household_id,id) WHERE file_present;
ALTER TABLE pactaris.task_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.task_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.task_proofs FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE TABLE pactaris.proof_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.proof_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.proof_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.proof_receipts FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.proof_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;t pactaris.partner_tasks;p pactaris.task_proofs;prior pactaris.proof_receipts;answer jsonb;rows jsonb;role text;
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('proofId',x.id,'type',x.type,'size',x.size,'state',x.state,'createdAt',x.created_at,
    'mine',x.author_id=m.id,'role',CASE WHEN x.author_id=m.id THEN 'author' ELSE 'viewer' END) ORDER BY x.created_at DESC),'[]'::jsonb) INTO rows
   FROM pactaris.task_proofs x WHERE x.household_id=target AND x.task_id=(payload->>'taskId')::uuid AND m.id IN (x.author_id,x.viewer_id);
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','proofs',rows);
 END IF;
 IF action='proofHead' THEN
  SELECT * INTO p FROM pactaris.task_proofs WHERE household_id=target AND id=(payload->>'proofId')::uuid AND m.id IN (author_id,viewer_id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  role=CASE WHEN p.author_id=m.id THEN 'author' ELSE 'viewer' END;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed',
   'proof',jsonb_build_object('proofId',p.id,'type',p.type,'size',p.size,'state',p.state,'role',role,
    'available',p.state='stored' AND p.file_present AND p.expires_at>now(),'consumes',role='viewer' AND p.state='stored'));
 END IF;
 -- Mutations carry a receipt for exact-operation retries.
 SELECT * INTO prior FROM pactaris.proof_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='proofPut' THEN
  SELECT * INTO t FROM pactaris.partner_tasks WHERE household_id=target AND id=(payload->>'taskId')::uuid;
  IF NOT FOUND OR t.assignee_id<>m.id OR t.state NOT IN ('assigned','accepted','in_progress','submitted','changes_requested') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  IF payload->>'type' NOT IN ('image/jpeg','image/png','image/webp') OR (payload->>'size')::integer NOT BETWEEN 1 AND 5242880 OR payload->>'sha256'!~'^[0-9a-f]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.invalid'; END IF;
  -- One active proof per task: supersede any earlier stored one (its file is purged by the sweep).
  UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=target AND task_id=t.id AND author_id=m.id AND state='stored';
  INSERT INTO pactaris.task_proofs(household_id,id,task_id,author_id,viewer_id,type,size,sha256,expires_at)
   VALUES(target,operation,t.id,m.id,t.creator_id,payload->>'type',(payload->>'size')::integer,payload->>'sha256',now()+interval '48 hours');
  answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',operation);
 ELSE
  SELECT * INTO p FROM pactaris.task_proofs WHERE household_id=target AND id=(payload->>'proofId')::uuid AND m.id IN (author_id,viewer_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
  IF action='proofViewed' THEN
   -- Only the recipient consumes the proof; viewing deletes the bytes.
   IF p.viewer_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='proof.denied'; END IF;
   IF p.state='stored' THEN UPDATE pactaris.task_proofs SET state='viewed',viewed_at=now() WHERE household_id=target AND id=p.id; END IF;
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id,'consumed',p.state='stored');
  ELSIF action='proofPurged' THEN
   -- Called after the bytes were deleted from disk.
   UPDATE pactaris.task_proofs SET file_present=false WHERE household_id=target AND id=p.id;
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id);
  ELSE
   -- proofRemove: either party may withdraw it; the sweep purges the file.
   IF p.state IN ('stored','viewed') THEN UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=target AND id=p.id; END IF;
   answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','proofId',p.id);
  END IF;
 END IF;
 INSERT INTO pactaris.proof_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'proof.'||action,(answer->>'proofId')::uuid,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.proof_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Worker sweep: expire proofs past their TTL, then list files that must be deleted from disk.
CREATE FUNCTION pactaris.proof_sweep(instance uuid) RETURNS TABLE(household_id uuid,id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 UPDATE pactaris.task_proofs x SET state='expired'
  FROM pactaris.households h WHERE h.id=x.household_id AND h.instance_id=instance AND x.state='stored' AND x.expires_at<=now();
 RETURN QUERY SELECT x.household_id,x.id FROM pactaris.task_proofs x JOIN pactaris.households h ON h.id=x.household_id
  WHERE h.instance_id=instance AND x.file_present AND x.state IN ('viewed','expired','removed') ORDER BY x.id LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION pactaris.proof_sweep(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.proof_mark_purged(target uuid,proof uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 UPDATE pactaris.task_proofs SET file_present=false WHERE household_id=target AND id=proof
$$;
REVOKE ALL ON FUNCTION pactaris.proof_mark_purged(uuid,uuid) FROM PUBLIC;

-- Departure or account erasure of either party removes the proof; the sweep then deletes its file.
CREATE FUNCTION pactaris.proof_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF (NEW.status<>'active' AND OLD.status='active') OR (NEW.account_erased_at IS NOT NULL AND OLD.account_erased_at IS NULL) THEN
  UPDATE pactaris.task_proofs SET state='removed' WHERE household_id=NEW.household_id AND NEW.id IN (author_id,viewer_id) AND state IN ('stored','viewed');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.proof_departure() FROM PUBLIC;
CREATE TRIGGER proof_departure AFTER UPDATE OF status,account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.proof_departure();
