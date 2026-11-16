-- Invitation content stays in the home Instance; only hashes of bearer tokens.
CREATE TABLE pactaris.invitations (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.households(id),
 creator_membership_id uuid NOT NULL,token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 recipient_hash text NOT NULL CHECK(recipient_hash ~ '^[a-f0-9]{64}$'),terms_version bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked')),
 accepted_account_id uuid,accepted_membership_id uuid,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '48 hours',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(household_id,creator_membership_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,accepted_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX ON pactaris.invitations(household_id,status,expires_at);
CREATE TABLE pactaris.invitation_receipts (
 operation_id uuid PRIMARY KEY,invitation_id uuid NOT NULL REFERENCES pactaris.invitations(id),
 account_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('inviteCreate','inviteAccept','inviteDecline','inviteRevoke')),
 request_hash text NOT NULL CHECK(length(request_hash)=64),result jsonb NOT NULL
);
CREATE TABLE pactaris.invitation_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.invitation_receipts(operation_id),
 household_id uuid NOT NULL REFERENCES pactaris.households(id),account_id uuid NOT NULL,
 membership_id uuid,event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz
);
ALTER TABLE pactaris.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.invitation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.invitation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.invitation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.invitation_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_command ON pactaris.invitations FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY invitation_receipts_command ON pactaris.invitation_receipts FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY invitation_outbox_command ON pactaris.invitation_outbox FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
-- Operational four-member alpha cap, not finalized commercial pricing. Existing
-- non-free/custom snapshots are never replaced; absent/invalid caps fail closed.
UPDATE pactaris.household_entitlements SET capabilities=capabilities||'{"members.active.max":4}'::jsonb
 WHERE capabilities->>'plan.key'='free' AND NOT capabilities?'members.active.max';

CREATE FUNCTION pactaris.invitation_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; inv pactaris.invitations; receipt pactaris.invitation_receipts;
 member pactaris.memberships; invitation uuid; answer jsonb; cap integer; active_count bigint; reserved_count bigint; new_member uuid;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$'
   OR action NOT IN ('inviteCreate','invitePreview','inviteAccept','inviteDecline','inviteRevoke','inviteList','inviteReceipt') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.invite.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied'; END IF;
 IF action='inviteReceipt' THEN
   SELECT * INTO receipt FROM pactaris.invitation_receipts WHERE operation_id=operation;
   IF NOT FOUND THEN RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','missing'); END IF;
   IF receipt.account_id<>actor OR receipt.invitation_id<>(body->>'invitationId')::uuid OR receipt.action<>'inviteAccept' THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied';
   END IF;
   SELECT * INTO inv FROM pactaris.invitations WHERE id=receipt.invitation_id AND household_id=target;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied'; END IF;
   RETURN receipt.result||jsonb_build_object('status',CASE WHEN EXISTS(
     SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=(receipt.result->>'membershipId')::uuid
       AND account_id=actor AND status='active') THEN 'accepted' ELSE 'left' END);
 END IF;
 SELECT * INTO member FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active';
 IF action IN ('inviteCreate','inviteList','inviteRevoke') THEN
   IF NOT FOUND OR member.id IS DISTINCT FROM (body->>'membershipId')::uuid OR member.technical_role NOT IN ('owner','admin') THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied';
   END IF;
 END IF;
 IF action='inviteList' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('invitationId',i.id,'role','participant','expiresAt',i.expires_at,
     'status',CASE WHEN i.status='pending' AND (i.expires_at<=now() OR i.terms_version<>h.safety_version OR NOT EXISTS(
       SELECT 1 FROM pactaris.memberships m WHERE m.household_id=target AND m.id=i.creator_membership_id AND m.status='active'
         AND m.technical_role IN ('owner','admin'))) THEN 'inactive' ELSE i.status END) ORDER BY i.created_at DESC),'[]'::jsonb)
     INTO answer FROM (SELECT * FROM pactaris.invitations WHERE household_id=target ORDER BY created_at DESC LIMIT 50) i;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','listed','invitations',answer);
 END IF;
 invitation=(body->>'invitationId')::uuid;
 SELECT * INTO receipt FROM pactaris.invitation_receipts WHERE operation_id=operation;
 IF FOUND THEN
   IF receipt.account_id<>actor OR receipt.invitation_id<>invitation OR receipt.action<>action OR receipt.request_hash<>fingerprint THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.conflict';
   END IF;
   -- Accepted receipts never authorize a newly rejoined membership.
   IF action='inviteAccept' AND NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target
      AND id=(receipt.result->>'membershipId')::uuid AND account_id=actor AND status='active') THEN
     RETURN receipt.result||'{"status":"left"}'::jsonb;
   END IF;
   RETURN receipt.result;
 END IF;
 IF action='inviteCreate' THEN
   IF h.status<>'active' OR body->>'tokenHash' IS NULL OR body->>'tokenHash'!~'^[a-f0-9]{64}$'
     OR body->>'recipientHash' IS NULL OR body->>'recipientHash'!~'^[a-f0-9]{64}$' THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied';
   END IF;
   IF EXISTS(SELECT 1 FROM pactaris.invitations WHERE id=invitation) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.conflict'; END IF;
 ELSE
   SELECT * INTO inv FROM pactaris.invitations WHERE id=invitation AND household_id=target FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied'; END IF;
   IF action<>'inviteRevoke' THEN
     IF body->>'tokenHash' IS DISTINCT FROM inv.token_hash OR body->>'recipientHash' IS DISTINCT FROM inv.recipient_hash THEN
       RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied';
     END IF;
   END IF;
 END IF;
 IF action IN ('inviteCreate','inviteAccept') THEN
   SELECT CASE WHEN capabilities->>'members.active.max' ~ '^[1-9][0-9]{0,3}$'
     THEN (capabilities->>'members.active.max')::integer ELSE NULL END INTO cap FROM pactaris.household_entitlements WHERE household_id=target;
   IF cap IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.capacity'; END IF;
   SELECT count(*) INTO active_count FROM pactaris.memberships WHERE household_id=target AND status IN ('active','invited');
 END IF;
 IF action='inviteCreate' THEN
   SELECT count(*) INTO reserved_count FROM pactaris.invitations i JOIN pactaris.memberships m
     ON m.household_id=target AND m.id=i.creator_membership_id WHERE i.household_id=target AND i.status='pending'
       AND i.expires_at>now() AND i.terms_version=h.safety_version AND m.status='active' AND m.technical_role IN ('owner','admin');
   IF active_count+reserved_count>=cap THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.capacity'; END IF;
   INSERT INTO pactaris.invitations(id,household_id,creator_membership_id,token_hash,recipient_hash,terms_version)
    VALUES(invitation,target,member.id,body->>'tokenHash',body->>'recipientHash',h.safety_version) RETURNING * INTO inv;
   answer=jsonb_build_object('status','pending','expiresAt',inv.expires_at);
 ELSIF action='inviteRevoke' THEN
   IF inv.status<>'pending' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.conflict'; END IF;
   UPDATE pactaris.invitations SET status='revoked' WHERE id=invitation;
   answer='{"status":"revoked"}'::jsonb;
 ELSE
   IF action='inviteAccept' AND inv.status='accepted' AND inv.accepted_account_id=actor THEN
     IF NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=inv.accepted_membership_id AND account_id=actor AND status='active') THEN
       RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.denied'; END IF;
     answer=jsonb_build_object('status','accepted','membershipId',inv.accepted_membership_id);
   ELSE
     IF inv.status<>'pending' OR inv.expires_at<=now() OR h.status<>'active' OR inv.terms_version<>h.safety_version OR
       NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=inv.creator_membership_id
         AND status='active' AND technical_role IN ('owner','admin')) THEN
       RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.conflict';
     END IF;
     IF action='invitePreview' THEN
       RETURN jsonb_build_object('householdId',target,'operationId',operation,'invitationId',invitation,
         'status','preview','name',h.display_name,'role','participant','termsVersion',inv.terms_version::text,'expiresAt',inv.expires_at);
     ELSIF action='inviteDecline' THEN
       UPDATE pactaris.invitations SET status='declined' WHERE id=invitation;
       answer='{"status":"declined"}'::jsonb;
     ELSIF action='inviteAccept' THEN
       IF (body->>'termsVersion')::bigint IS DISTINCT FROM inv.terms_version OR active_count>=cap OR
         EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status IN ('active','invited')) THEN
         RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.conflict';
       END IF;
       new_member=gen_random_uuid();
       INSERT INTO pactaris.memberships(household_id,id,account_id,status,technical_role) VALUES(target,new_member,actor,'active','participant');
       UPDATE pactaris.invitations SET status='accepted',accepted_account_id=actor,accepted_membership_id=new_member WHERE id=invitation;
       answer=jsonb_build_object('status','accepted','membershipId',new_member);
     ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='invite.invalid';
     END IF;
   END IF;
 END IF;
 answer=answer||jsonb_build_object('householdId',target,'operationId',operation,'invitationId',invitation);
 INSERT INTO pactaris.invitation_receipts(operation_id,invitation_id,account_id,action,request_hash,result)
   VALUES(operation,invitation,actor,action,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'invitation.'||action,invitation,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.invitation_outbox(operation_id,household_id,account_id,membership_id,event_key)
   VALUES(operation,target,actor,(answer->>'membershipId')::uuid,'invitation.'||action);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.invitation_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
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
   VALUES(target,1,'{"plan.key":"free","policy.version":1,"members.active.max":4}'::jsonb);
 answer=jsonb_build_object('householdId',target,'operationId',operation,'membershipId',member,'status','created');
 INSERT INTO pactaris.household_command_receipts(operation_id,household_id,account_id,action,request_hash,result)
   VALUES(operation,target,actor,'create',fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'household.created',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.household_outbox(id,household_id,operation_id,account_id,event_key)
   VALUES(gen_random_uuid(),target,operation,actor,'household.created');
 RETURN answer;
END $$;

