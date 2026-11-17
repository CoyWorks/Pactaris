-- Personal preparation only. A saved point cost is not a grant, debit or consent.
CREATE TABLE pactaris.catalog_items (
 household_id uuid NOT NULL,id uuid NOT NULL,creator_membership_id uuid NOT NULL,
 version bigint NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','archived')),
 PRIMARY KEY(household_id,id),FOREIGN KEY(household_id,creator_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.catalog_versions (
 household_id uuid NOT NULL,item_id uuid NOT NULL,version bigint NOT NULL,fields jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,item_id,version),FOREIGN KEY(household_id,item_id) REFERENCES pactaris.catalog_items(household_id,id)
);
CREATE TABLE pactaris.catalog_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.catalog_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.catalog_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['catalog_items','catalog_versions','catalog_receipts','catalog_outbox'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;
CREATE FUNCTION pactaris.catalog_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE item pactaris.catalog_items;
BEGIN IF OLD.status='active' AND NEW.status<>'active' THEN
 FOR item IN SELECT * FROM pactaris.catalog_items WHERE household_id=NEW.household_id AND creator_membership_id=NEW.id AND state='draft' LOOP
  INSERT INTO pactaris.catalog_versions(household_id,item_id,version,fields) SELECT item.household_id,item.id,item.version+1,fields FROM pactaris.catalog_versions WHERE household_id=item.household_id AND item_id=item.id AND version=item.version;
  UPDATE pactaris.catalog_items SET state='archived',version=version+1 WHERE household_id=item.household_id AND id=item.id;
 END LOOP;
END IF;RETURN NEW;END $$;
CREATE TRIGGER catalog_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.catalog_departure();
REVOKE ALL ON FUNCTION pactaris.catalog_departure() FROM PUBLIC;
CREATE FUNCTION pactaris.catalog_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;r pactaris.catalog_items;v pactaris.catalog_versions;receipt pactaris.catalog_receipts;
 answer jsonb;items jsonb;f jsonb;cursor text;chosen bigint;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR action IS NULL OR action NOT IN ('catalogList','catalogRead','catalogCreate','catalogUpdate','catalogArchive','catalogRestore') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.catalog.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
 SELECT * INTO receipt FROM pactaris.catalog_receipts WHERE operation_id=operation;
 IF FOUND THEN IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;RETURN receipt.result;END IF;
 IF action='catalogList' THEN
  IF payload->>'filter' IS NULL OR payload->>'filter' NOT IN ('current','archived') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',x.id,'version',x.version::text,'state',x.state)||x.fields ORDER BY (x.fields->>'position')::int,x.id),'[]'::jsonb) INTO items
   FROM (SELECT i.*,c.fields FROM pactaris.catalog_items i JOIN pactaris.catalog_versions c ON c.household_id=i.household_id AND c.item_id=i.id AND c.version=i.version
    WHERE i.household_id=target AND i.creator_membership_id=m.id AND (CASE WHEN payload->>'filter'='archived' THEN i.state='archived' ELSE i.state='draft' END)
     AND (payload->>'after' IS NULL OR ((c.fields->>'position')::int,i.id)>(split_part(payload->>'after',':',1)::int,split_part(payload->>'after',':',2)::uuid))
    ORDER BY (c.fields->>'position')::int,i.id LIMIT 11) x;
  IF jsonb_array_length(items)=11 THEN cursor=(items->9->>'position')||':'||(items->9->>'itemId');items=items-10;END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','items',items,'nextCursor',cursor);
 END IF;
 IF action='catalogCreate' THEN
  f=payload->'fields';
  INSERT INTO pactaris.catalog_items(household_id,id,creator_membership_id) VALUES(target,operation,m.id) RETURNING * INTO r;
 ELSE
  SELECT * INTO r FROM pactaris.catalog_items WHERE household_id=target AND id=(payload->>'itemId')::uuid AND creator_membership_id=m.id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;
  IF action<>'catalogRead' AND r.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
  chosen=CASE WHEN action='catalogRead' THEN coalesce((payload->>'version')::bigint,r.version) ELSE r.version END;
  SELECT * INTO v FROM pactaris.catalog_versions WHERE household_id=target AND item_id=r.id AND version=chosen;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.denied';END IF;f=v.fields;
 END IF;
 IF action='catalogRead' THEN
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','item',f||jsonb_build_object('itemId',r.id,'version',chosen::text,'state',r.state,'historical',chosen<>r.version));
 ELSIF action IN ('catalogCreate','catalogUpdate') THEN
  IF action='catalogUpdate' THEN
   IF r.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;f=payload->'fields';
  END IF;
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f->>'title' IS NULL OR char_length(f->>'title') NOT BETWEEN 1 AND 120 OR f->>'description' IS NULL OR char_length(f->>'description')>500 OR f->>'category' IS NULL OR char_length(f->>'category')>60 OR f->>'position' IS NULL OR (f->>'position')::int NOT BETWEEN 0 AND 999999 OR NOT(f?'points') OR (f->>'points' IS NOT NULL AND (f->>'points')::int NOT BETWEEN 0 AND 1000000) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.invalid';END IF;
 ELSIF action='catalogArchive' THEN
  IF r.state<>'draft' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
 ELSIF action='catalogRestore' THEN
  IF r.state<>'archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='catalog.conflict';END IF;
 END IF;
 IF action<>'catalogCreate' THEN UPDATE pactaris.catalog_items SET version=version+1,state=CASE WHEN action='catalogArchive' THEN 'archived' WHEN action='catalogRestore' THEN 'draft' ELSE state END WHERE household_id=target AND id=r.id RETURNING * INTO r;END IF;
 INSERT INTO pactaris.catalog_versions(household_id,item_id,version,fields) VALUES(target,r.id,r.version,f);
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','itemId',r.id);
 INSERT INTO pactaris.catalog_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters) VALUES(target,gen_random_uuid(),actor,'catalog.'||action,r.id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.catalog_outbox VALUES(operation,target,'catalog.'||action,now());RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.catalog_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
