CREATE TABLE pactaris.documents (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_membership_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('rule','protocol','note')),
 version bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','archived','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,creator_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.document_versions (
 household_id uuid NOT NULL,document_id uuid NOT NULL,version bigint NOT NULL,title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),
 body text NOT NULL CHECK(char_length(body)<=2000),category text NOT NULL CHECK(char_length(category)<=60),position integer NOT NULL CHECK(position BETWEEN 0 AND 999999),
 visibility text NOT NULL CHECK(visibility IN ('private','participants','household')),recipients jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','published','archived')),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,document_id,version),FOREIGN KEY(household_id,document_id) REFERENCES pactaris.documents(household_id,id)
);
CREATE INDEX documents_kind ON pactaris.documents(household_id,kind,state,id);
CREATE TABLE pactaris.document_acknowledgements (
 household_id uuid NOT NULL,document_id uuid NOT NULL,version bigint NOT NULL,membership_id uuid NOT NULL,acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,document_id,version,membership_id),FOREIGN KEY(household_id,document_id,version) REFERENCES pactaris.document_versions(household_id,document_id,version),
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.document_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.document_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.document_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['documents','document_versions','document_acknowledgements','document_receipts','document_outbox'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;
-- One visibility predicate for lists, search, detail and acknowledgement.
CREATE FUNCTION pactaris.document_visible(tenant uuid,resource uuid,viewer uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pactaris.documents d JOIN pactaris.document_versions v ON v.household_id=d.household_id AND v.document_id=d.id AND v.version=d.version
  WHERE d.household_id=tenant AND d.id=resource AND d.state<>'deleted' AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=tenant AND id=viewer AND status='active')
   AND (d.creator_membership_id=viewer OR (d.state='published' AND (v.visibility='household' OR (v.visibility='participants' AND v.recipients ? viewer::text)))))
$$;
REVOKE ALL ON FUNCTION pactaris.document_visible(uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION pactaris.document_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE d pactaris.documents;
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  FOR d IN SELECT * FROM pactaris.documents WHERE household_id=NEW.household_id AND creator_membership_id=NEW.id AND state IN ('draft','published') LOOP
   INSERT INTO pactaris.document_versions(household_id,document_id,version,title,body,category,position,visibility,recipients,state)
    SELECT household_id,document_id,version+1,title,body,category,position,visibility,recipients,'archived' FROM pactaris.document_versions WHERE household_id=d.household_id AND document_id=d.id AND version=d.version;
   UPDATE pactaris.documents SET state='archived',version=version+1,updated_at=statement_timestamp() WHERE household_id=d.household_id AND id=d.id;
  END LOOP;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER document_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.document_departure();
REVOKE ALL ON FUNCTION pactaris.document_departure() FROM PUBLIC;
CREATE FUNCTION pactaris.document_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;d pactaris.documents;v pactaris.document_versions;receipt pactaris.document_receipts;
 answer jsonb;items jsonb;acks jsonb;fields jsonb;new_state text;recipient uuid;more_acks boolean:=false;next_cursor text;requested_version bigint;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('documentList','documentRead','documentCreate','documentUpdate','documentPublish','documentArchive','documentRestore','documentDelete','documentAcknowledge') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.document.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
 SELECT * INTO receipt FROM pactaris.document_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict';END IF;RETURN receipt.result;
 END IF;
 IF action='documentList' THEN
  IF body->>'kind' IS NULL OR body->>'kind' NOT IN ('rule','protocol','note') OR body->>'filter' IS NULL OR body->>'filter' NOT IN ('active','archived') OR body->>'query' IS NULL OR char_length(body->>'query')>80 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',x.id,'kind',x.kind,'title',x.title,'category',x.category,'position',x.position,'version',x.version::text,'state',x.state,'visibility',x.visibility,
   'canEdit',x.creator_membership_id=m.id,'creatorMembershipId',x.creator_membership_id,'acknowledged',EXISTS(SELECT 1 FROM pactaris.document_acknowledgements a WHERE a.household_id=target AND a.document_id=x.id AND a.version=x.version AND a.membership_id=m.id)) ORDER BY x.position,x.id),'[]'::jsonb) INTO items
   FROM (SELECT doc.*,dv.title,dv.category,dv.position,dv.visibility FROM pactaris.documents doc JOIN pactaris.document_versions dv ON dv.household_id=doc.household_id AND dv.document_id=doc.id AND dv.version=doc.version
    WHERE doc.household_id=target AND doc.kind=body->>'kind' AND pactaris.document_visible(target,doc.id,m.id)
     AND (CASE WHEN body->>'filter'='archived' THEN doc.state='archived' ELSE doc.state IN ('draft','published') END)
     AND strpos(lower(dv.title||' '||dv.category||' '||dv.body),lower(body->>'query'))>0
     AND (body->>'after' IS NULL OR (dv.position,doc.id)>(split_part(body->>'after',':',1)::int,split_part(body->>'after',':',2)::uuid)) ORDER BY dv.position,doc.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN next_cursor=(items->9->>'position')||':'||(items->9->>'documentId');items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','documents',items,'nextCursor',next_cursor);
 END IF;
 IF action='documentCreate' THEN
  IF body->>'kind' IS NULL OR body->>'kind' NOT IN ('rule','protocol','note') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
  INSERT INTO pactaris.documents(household_id,id,creator_membership_id,kind) VALUES(target,operation,m.id,body->>'kind') RETURNING * INTO d;
 ELSE
  SELECT * INTO d FROM pactaris.documents WHERE household_id=target AND id=(body->>'documentId')::uuid;
  IF NOT FOUND OR NOT pactaris.document_visible(target,d.id,m.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
  IF action='documentRead' THEN
   requested_version=coalesce((body->>'version')::bigint,d.version);
   IF requested_version<>d.version AND d.creator_membership_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
   SELECT * INTO v FROM pactaris.document_versions WHERE household_id=target AND document_id=d.id AND version=requested_version;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',a.membership_id,'acknowledgedAt',a.acknowledged_at) ORDER BY a.membership_id),'[]'::jsonb) INTO acks
    FROM (SELECT ack.* FROM pactaris.document_acknowledgements ack WHERE ack.household_id=target AND ack.document_id=d.id AND ack.version=v.version AND
     (ack.membership_id=m.id OR (d.creator_membership_id=m.id AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=ack.membership_id AND status='active'))) ORDER BY ack.membership_id LIMIT 21) a;
   IF jsonb_array_length(acks)=21 THEN more_acks=true;acks=acks-20;END IF;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','document',jsonb_build_object('documentId',d.id,'kind',d.kind,'title',v.title,'body',v.body,'category',v.category,'position',v.position,'visibility',v.visibility,
    'recipients',CASE WHEN d.creator_membership_id=m.id THEN v.recipients ELSE '[]'::jsonb END,'version',v.version::text,'state',v.state,'canEdit',d.creator_membership_id=m.id,
    'creatorMembershipId',d.creator_membership_id,'historical',v.version<>d.version,'acknowledged',EXISTS(SELECT 1 FROM pactaris.document_acknowledgements WHERE household_id=target AND document_id=d.id AND version=v.version AND membership_id=m.id),
    'acknowledgements',acks,'moreAcknowledgements',more_acks));
  END IF;
  IF d.version::text IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict';END IF;
  IF action='documentAcknowledge' THEN
   IF d.kind='note' OR d.state<>'published' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict';END IF;
   INSERT INTO pactaris.document_acknowledgements(household_id,document_id,version,membership_id) VALUES(target,d.id,d.version,m.id) ON CONFLICT DO NOTHING;
  ELSE
   IF d.creator_membership_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
   SELECT * INTO v FROM pactaris.document_versions WHERE household_id=target AND document_id=d.id AND version=d.version;
   IF action='documentDelete' THEN
    IF d.kind<>'note' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
    DELETE FROM pactaris.document_acknowledgements WHERE household_id=target AND document_id=d.id;
    DELETE FROM pactaris.document_versions WHERE household_id=target AND document_id=d.id;
    UPDATE pactaris.documents SET state='deleted',version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=d.id;
   ELSE
    IF action='documentPublish' AND d.state<>'draft' OR action='documentArchive' AND d.state='archived' OR action='documentRestore' AND d.state<>'archived' OR action='documentUpdate' AND d.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict';END IF;
    new_state=CASE WHEN action='documentPublish' THEN 'published' WHEN action='documentArchive' THEN 'archived' ELSE 'draft' END;
    UPDATE pactaris.documents SET state=new_state,version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=d.id RETURNING * INTO d;
    IF action<>'documentUpdate' THEN
     INSERT INTO pactaris.document_versions(household_id,document_id,version,title,body,category,position,visibility,recipients,state)
      VALUES(target,d.id,d.version,v.title,v.body,v.category,v.position,v.visibility,v.recipients,new_state);
    END IF;
   END IF;
  END IF;
 END IF;
 IF action IN ('documentCreate','documentUpdate') THEN
  fields=body->'fields';
  IF fields->>'title' IS NULL OR char_length(fields->>'title') NOT BETWEEN 1 AND 120 OR fields->>'body' IS NULL OR char_length(fields->>'body')>2000 OR fields->>'category' IS NULL OR char_length(fields->>'category')>60 OR
   (fields->>'position')::int NOT BETWEEN 0 AND 999999 OR fields->>'position' IS NULL OR fields->>'visibility' IS NULL OR fields->>'visibility' NOT IN ('private','participants','household') OR jsonb_typeof(fields->'recipients') IS DISTINCT FROM 'array' OR jsonb_array_length(fields->'recipients')>8 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
  IF fields->>'visibility'='participants' THEN
   IF jsonb_array_length(fields->'recipients')<1 OR (SELECT count(DISTINCT r::uuid) FROM jsonb_array_elements_text(fields->'recipients') r)<>jsonb_array_length(fields->'recipients') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
   FOR recipient IN SELECT r::uuid FROM jsonb_array_elements_text(fields->'recipients') r LOOP
    IF recipient=m.id OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=recipient AND status='active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.denied';END IF;
   END LOOP;
  ELSIF jsonb_array_length(fields->'recipients')<>0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.invalid';END IF;
  INSERT INTO pactaris.document_versions(household_id,document_id,version,title,body,category,position,visibility,recipients,state)
   VALUES(target,d.id,d.version,fields->>'title',fields->>'body',fields->>'category',(fields->>'position')::int,fields->>'visibility',fields->'recipients','draft');
 END IF;
 IF action='documentPublish' THEN
  -- Selected recipients must still be the same current membership generations.
  SELECT * INTO v FROM pactaris.document_versions WHERE household_id=target AND document_id=d.id AND version=d.version;
  IF v.visibility='participants' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.recipients) r WHERE NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=r::uuid AND status='active')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='library.conflict';END IF;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','documentId',d.id);
 INSERT INTO pactaris.document_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'library.'||action,d.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.document_outbox VALUES(operation,target,'library.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.document_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
