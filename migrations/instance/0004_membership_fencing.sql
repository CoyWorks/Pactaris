-- Preserve historical membership identity before invitation/rejoin support.
-- The old unique constraint proves the backfill; unexpected missing rows abort.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pactaris.household_command_receipts r
   WHERE NOT EXISTS(SELECT 1 FROM pactaris.memberships m
     WHERE m.household_id=r.household_id AND m.account_id=r.account_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='membership.backfill_required';
 END IF;
END $$;
UPDATE pactaris.household_command_receipts r
 SET result=r.result||jsonb_build_object('membershipId',m.id)
 FROM pactaris.memberships m WHERE m.household_id=r.household_id AND m.account_id=r.account_id;
ALTER TABLE pactaris.memberships DROP CONSTRAINT memberships_household_id_account_id_key;
CREATE UNIQUE INDEX memberships_current_account ON pactaris.memberships(household_id,account_id)
 WHERE status IN ('invited','active');
CREATE FUNCTION pactaris.membership_history_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.household_id<>OLD.household_id OR NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR
   (OLD.status IN ('left','revoked') AND NEW.status IN ('invited','active')) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='membership.history';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memberships_history BEFORE UPDATE ON pactaris.memberships
 FOR EACH ROW EXECUTE FUNCTION pactaris.membership_history_guard();

CREATE OR REPLACE FUNCTION pactaris.create_household_command(
 target uuid, instance uuid, actor uuid, operation uuid, name text, fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; answer jsonb; member uuid;
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
       WHERE m.household_id=target AND m.account_id=actor AND m.id=(receipt.result->>'membershipId')::uuid AND m.status='active' AND h.instance_id=instance AND h.status<>'closed') THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
   END IF;
   RETURN receipt.result;
 END IF;
 IF EXISTS(SELECT 1 FROM pactaris.households WHERE id=target) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
 END IF;
 INSERT INTO pactaris.households(id,instance_id,display_name) VALUES(target,instance,name);
 INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role)
   VALUES(target,gen_random_uuid(),actor,'active','owner') RETURNING id INTO member;
 -- Explicit versioned free pilot snapshot; commercial quota values are not selected here.
 INSERT INTO pactaris.household_entitlements(household_id,version,capabilities)
   VALUES(target,1,'{"plan.key":"free","policy.version":1}'::jsonb);
 answer=jsonb_build_object('householdId',target,'operationId',operation,'membershipId',member,'status','created');
 INSERT INTO pactaris.household_command_receipts(operation_id,household_id,account_id,action,request_hash,result)
   VALUES(operation,target,actor,'create',fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'household.created',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.household_outbox(id,household_id,operation_id,account_id,event_key)
   VALUES(gen_random_uuid(),target,operation,actor,'household.created');
 RETURN answer;
END $$;

CREATE FUNCTION pactaris.leave_household_command(
 target uuid, instance uuid, actor uuid, operation uuid, fingerprint text, expected uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; answer jsonb; remaining bigint; owners bigint;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR expected IS NULL OR
    fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF FOUND THEN
   IF receipt.household_id<>target OR receipt.account_id<>actor OR receipt.action<>'leave' OR receipt.request_hash<>fingerprint OR (receipt.result->>'membershipId')::uuid IS DISTINCT FROM expected OR
     NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
   END IF;
   RETURN receipt.result;
 END IF;
 PERFORM 1 FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND id=expected AND status='active') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
 END IF;
 UPDATE pactaris.memberships SET status='left' WHERE household_id=target AND account_id=actor AND id=expected AND status='active';
 SELECT count(*),count(*) FILTER(WHERE technical_role='owner') INTO remaining,owners
   FROM pactaris.memberships WHERE household_id=target AND status='active';
 -- Never require another member's approval to leave or assign them ownership.
 -- An ownerless group pauses; its remaining members keep their memberships.
 UPDATE pactaris.households SET safety_version=safety_version+1,
   status=CASE WHEN remaining=0 THEN 'closed' WHEN owners=0 THEN 'paused' ELSE status END WHERE id=target;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'membershipId',expected,'status','left');
 INSERT INTO pactaris.household_command_receipts(operation_id,household_id,account_id,action,request_hash,result)
   VALUES(operation,target,actor,'leave',fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'household.membershipLeft',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.household_outbox(id,household_id,operation_id,account_id,event_key)
   VALUES(gen_random_uuid(),target,operation,actor,'household.membershipLeft');
 RETURN answer;
END $$;
-- Compatibility for an already staged old gateway/command: no old command
-- can choose a newer membership once any historical membership exists.
CREATE OR REPLACE FUNCTION pactaris.leave_household_command(
 target uuid, instance uuid, actor uuid, operation uuid, fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE member uuid; receipt pactaris.household_command_receipts; total bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF FOUND THEN
   IF receipt.household_id<>target OR receipt.account_id<>actor OR receipt.action<>'leave' OR receipt.request_hash<>fingerprint THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.conflict';
   END IF;
   member=(receipt.result->>'membershipId')::uuid;
 ELSE
   SELECT count(*) INTO total FROM pactaris.memberships WHERE household_id=target AND account_id=actor;
   IF total<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied'; END IF;
   SELECT id INTO member FROM pactaris.memberships WHERE household_id=target AND account_id=actor;
 END IF;
 RETURN pactaris.leave_household_command(target,instance,actor,operation,fingerprint,member);
END $$;
REVOKE ALL ON FUNCTION pactaris.leave_household_command(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pactaris.leave_household_command(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pactaris.create_household_command(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
-- Non-mutating domain receipt inspection for lost-response reconciliation.
CREATE OR REPLACE FUNCTION pactaris.household_receipt_command(target uuid,instance uuid,actor uuid,operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; state text;
BEGIN
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF NOT FOUND THEN
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','missing');
 END IF;
 IF receipt.household_id<>target OR receipt.account_id<>actor OR
    NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
 END IF;
 state=CASE WHEN receipt.action='leave' THEN 'left'
   WHEN EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND id=(receipt.result->>'membershipId')::uuid AND status='active') THEN 'created'
   ELSE 'left' END;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'membershipId',receipt.result->>'membershipId','status',state);
END $$;
REVOKE ALL ON FUNCTION pactaris.household_receipt_command(uuid,uuid,uuid,uuid) FROM PUBLIC;
