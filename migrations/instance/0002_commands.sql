-- Narrow transactional command functions. Runtime remains non-owner/non-BYPASSRLS.
CREATE TABLE pactaris.household_command_receipts (
 operation_id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES pactaris.households(id),
 account_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('create','leave')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pactaris.household_outbox (
 id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES pactaris.households(id),
 operation_id uuid NOT NULL UNIQUE REFERENCES pactaris.household_command_receipts(operation_id),
 account_id uuid NOT NULL, event_key text NOT NULL CHECK(event_key IN ('household.created','household.membershipLeft')),
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
ALTER TABLE pactaris.household_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.household_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.household_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.household_outbox FORCE ROW LEVEL SECURITY;

-- Independent of user-settable GUCs: only the schema/table owner executing a
-- reviewed SECURITY DEFINER command qualifies. Runtime cannot SET ROLE to it.
CREATE FUNCTION pactaris.command_executor() RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT current_user=pg_get_userbyid(c.relowner)
 FROM pg_catalog.pg_class c WHERE c.oid='pactaris.households'::regclass
$$;
CREATE POLICY households_command ON pactaris.households FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY memberships_command ON pactaris.memberships FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY entitlements_command ON pactaris.household_entitlements FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY audit_command ON pactaris.audit_events FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY receipts_command ON pactaris.household_command_receipts FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY outbox_command ON pactaris.household_outbox FOR ALL
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.create_household_command(
 target uuid, instance uuid, actor uuid, operation uuid, name text, fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; answer jsonb;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR
    name IS NULL OR char_length(name) NOT BETWEEN 1 AND 120 OR name<>btrim(name) OR
    fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF FOUND THEN
   IF receipt.household_id<>target OR receipt.account_id<>actor OR receipt.action<>'create' OR receipt.request_hash<>fingerprint THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
       WHERE m.household_id=target AND m.account_id=actor AND m.status='active' AND h.instance_id=instance AND h.status<>'closed') THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
   END IF;
   RETURN receipt.result;
 END IF;
 IF EXISTS(SELECT 1 FROM pactaris.households WHERE id=target) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
 END IF;
 INSERT INTO pactaris.households(id,instance_id,display_name) VALUES(target,instance,name);
 INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role)
   VALUES(target,gen_random_uuid(),actor,'active','owner');
 -- Explicit versioned free pilot snapshot; commercial quota values are not selected here.
 INSERT INTO pactaris.household_entitlements(household_id,version,capabilities)
   VALUES(target,1,'{"plan.key":"free","policy.version":1}'::jsonb);
 answer=jsonb_build_object('householdId',target,'operationId',operation,'status','created');
 INSERT INTO pactaris.household_command_receipts(operation_id,household_id,account_id,action,request_hash,result)
   VALUES(operation,target,actor,'create',fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'household.created',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.household_outbox(id,household_id,operation_id,account_id,event_key)
   VALUES(gen_random_uuid(),target,operation,actor,'household.created');
 RETURN answer;
END $$;

CREATE FUNCTION pactaris.leave_household_command(
 target uuid, instance uuid, actor uuid, operation uuid, fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; answer jsonb; remaining bigint; owners bigint;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR
    fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF FOUND THEN
   IF receipt.household_id<>target OR receipt.account_id<>actor OR receipt.action<>'leave' OR receipt.request_hash<>fingerprint OR
     NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
   END IF;
   RETURN receipt.result;
 END IF;
 PERFORM 1 FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
 END IF;
 UPDATE pactaris.memberships SET status='left' WHERE household_id=target AND account_id=actor;
 SELECT count(*),count(*) FILTER(WHERE technical_role='owner') INTO remaining,owners
   FROM pactaris.memberships WHERE household_id=target AND status='active';
 -- Never require another member's approval to leave or assign them ownership.
 -- An ownerless group pauses; its remaining members keep their memberships.
 UPDATE pactaris.households SET safety_version=safety_version+1,
   status=CASE WHEN remaining=0 THEN 'closed' WHEN owners=0 THEN 'paused' ELSE status END WHERE id=target;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'status','left');
 INSERT INTO pactaris.household_command_receipts(operation_id,household_id,account_id,action,request_hash,result)
   VALUES(operation,target,actor,'leave',fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'household.membershipLeft',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.household_outbox(id,household_id,operation_id,account_id,event_key)
   VALUES(gen_random_uuid(),target,operation,actor,'household.membershipLeft');
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.create_household_command(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pactaris.leave_household_command(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
