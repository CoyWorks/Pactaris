CREATE TABLE pactaris.draft_attachments (
 household_id uuid NOT NULL, document_id uuid NOT NULL, version bigint NOT NULL,
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1536),
 PRIMARY KEY(household_id,document_id),
 FOREIGN KEY(household_id,document_id,version) REFERENCES pactaris.document_versions(household_id,document_id,version) ON DELETE CASCADE
);
ALTER TABLE pactaris.draft_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.draft_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.draft_attachments FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.discard_draft_attachment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.version IS DISTINCT FROM NEW.version OR OLD.state IS DISTINCT FROM NEW.state THEN
  DELETE FROM pactaris.draft_attachments WHERE household_id=NEW.household_id AND document_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.discard_draft_attachment() FROM PUBLIC;
CREATE TRIGGER discard_draft_attachment AFTER UPDATE OF version,state ON pactaris.documents
 FOR EACH ROW EXECUTE FUNCTION pactaris.discard_draft_attachment();

CREATE FUNCTION pactaris.draft_attachment_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE d pactaris.documents; m pactaris.memberships; prior pactaris.document_receipts; file_bytes bytea; answer jsonb;
BEGIN
 IF action IS NULL OR action NOT IN ('documentAttachmentGet','documentAttachmentPut','documentAttachmentDelete')
    OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.document.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 PERFORM 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(payload->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 SELECT * INTO d FROM pactaris.documents WHERE household_id=target AND id=(payload->>'documentId')::uuid
   AND creator_membership_id=m.id AND state='draft';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
 IF d.version::text IS DISTINCT FROM payload->>'version' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict'; END IF;
 IF action='documentAttachmentGet' THEN
  SELECT bytes INTO file_bytes FROM pactaris.draft_attachments WHERE household_id=target AND document_id=d.id AND version=d.version;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied'; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,
    'status','listed','attachment',replace(encode(file_bytes,'base64'),chr(10),''));
 END IF;
 SELECT * INTO prior FROM pactaris.document_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='documentAttachmentPut' THEN
  file_bytes=decode(payload->>'attachment','base64');
  IF file_bytes IS NULL OR octet_length(file_bytes) NOT BETWEEN 1 AND 1536 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid'; END IF;
  INSERT INTO pactaris.draft_attachments VALUES(target,d.id,d.version,file_bytes)
   ON CONFLICT(household_id,document_id) DO UPDATE SET bytes=excluded.bytes,version=excluded.version;
 ELSE
  DELETE FROM pactaris.draft_attachments WHERE household_id=target AND document_id=d.id AND version=d.version;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','documentId',d.id);
 INSERT INTO pactaris.document_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'library.'||action,d.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.document_outbox VALUES(operation,target,'library.'||action,now());
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.draft_attachment_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
