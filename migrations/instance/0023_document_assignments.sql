CREATE TABLE pactaris.document_assignments (
 household_id uuid NOT NULL, document_id uuid NOT NULL, version bigint NOT NULL, recipient_id uuid NOT NULL,
 PRIMARY KEY(household_id,document_id,version,recipient_id),
 FOREIGN KEY(household_id,document_id,version) REFERENCES pactaris.document_versions(household_id,document_id,version),
 FOREIGN KEY(household_id,recipient_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.document_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.document_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.document_assignments FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.document_assignment_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE d pactaris.documents;m pactaris.memberships;receipt pactaris.document_receipts;
 answer jsonb;recipient uuid;roster jsonb;
BEGIN
 IF action='documentRead' THEN
  answer=pactaris.document_command(target,instance,actor,operation,action,payload,fingerprint);
  IF answer#>>'{document,state}'='published' AND answer#>>'{document,historical}'='false' THEN
   SELECT coalesce(jsonb_agg(a.recipient_id ORDER BY a.recipient_id),'[]'::jsonb) INTO roster
    FROM pactaris.document_assignments a
    WHERE a.household_id=target AND a.document_id=(answer#>>'{document,documentId}')::uuid
      AND a.version=(answer#>>'{document,version}')::bigint
      AND (answer#>>'{document,canEdit}'='true' OR a.recipient_id=(payload->>'membershipId')::uuid)
      AND pactaris.document_visible(target,a.document_id,a.recipient_id);
   answer=jsonb_set(answer,'{document,assignedRecipients}',roster);
  END IF;
  RETURN answer;
 END IF;
 IF action IS NULL OR action NOT IN ('documentAssign','documentUnassign') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.document.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 PERFORM 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(payload->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.document_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT * INTO d FROM pactaris.documents WHERE household_id=target AND id=(payload->>'documentId')::uuid
  AND creator_membership_id=m.id AND kind IN ('rule','protocol');
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 IF d.state<>'published' OR d.version::text IS DISTINCT FROM payload->>'version' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict'; END IF;
 recipient=(payload->>'recipientId')::uuid;
 IF recipient IS NULL OR recipient=m.id OR NOT pactaris.document_visible(target,d.id,recipient) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 IF action='documentAssign' THEN
  IF (SELECT count(*) FROM pactaris.document_assignments a WHERE a.household_id=target AND a.document_id=d.id AND a.version=d.version
      AND a.recipient_id<>recipient AND pactaris.document_visible(target,d.id,a.recipient_id))>=8 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict'; END IF;
  INSERT INTO pactaris.document_assignments VALUES(target,d.id,d.version,recipient) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM pactaris.document_assignments WHERE household_id=target AND document_id=d.id AND version=d.version AND recipient_id=recipient;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','documentId',d.id);
 INSERT INTO pactaris.document_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'library.'||action,d.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.document_outbox VALUES(operation,target,'library.'||action,now());
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.document_assignment_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
