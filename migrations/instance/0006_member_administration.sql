ALTER TABLE pactaris.memberships ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(char_length(display_name)<=80),
 ADD COLUMN role_version bigint NOT NULL DEFAULT 1 CHECK(role_version>0),ADD COLUMN ended_at timestamptz;
CREATE TABLE pactaris.ownership_offers (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.households(id),
 from_membership_id uuid NOT NULL,to_membership_id uuid NOT NULL,
 from_role_version bigint NOT NULL,to_role_version bigint NOT NULL,safety_version bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled','expired','invalidated')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(household_id,from_membership_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,to_membership_id) REFERENCES pactaris.memberships(household_id,id),
 CHECK(from_membership_id<>to_membership_id)
);
CREATE UNIQUE INDEX ownership_offer_source_pending ON pactaris.ownership_offers(household_id,from_membership_id) WHERE status='pending';
CREATE TABLE pactaris.membership_endings (
 household_id uuid NOT NULL,membership_id uuid NOT NULL,account_id uuid NOT NULL,
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),end_status text NOT NULL CHECK(end_status IN ('left','revoked')),
 ended_at timestamptz,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,membership_id),
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.membership_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.households(id),
 actor_account_id uuid NOT NULL,actor_membership_id uuid NOT NULL,action text NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.membership_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.membership_receipts(operation_id),
 household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz
);
ALTER TABLE pactaris.ownership_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.ownership_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_endings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_endings FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.membership_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY ownership_offers_command ON pactaris.ownership_offers FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY membership_endings_command ON pactaris.membership_endings FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY membership_receipts_command ON pactaris.membership_receipts FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY membership_outbox_command ON pactaris.membership_outbox FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
-- Historical end times were not tracked. Keep them unknown rather than inventing
-- timestamps; recorded_at states when this migration captured the local tombstone.
INSERT INTO pactaris.membership_endings(household_id,membership_id,account_id,end_status,ended_at)
 SELECT household_id,id,account_id,status,ended_at FROM pactaris.memberships WHERE status IN ('left','revoked');
CREATE FUNCTION pactaris.member_lifecycle_before() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.technical_role IS DISTINCT FROM OLD.technical_role THEN NEW.role_version=OLD.role_version+1; END IF;
 IF NEW.status IN ('left','revoked') AND OLD.status NOT IN ('left','revoked') THEN
   NEW.ended_at=statement_timestamp();NEW.display_name='';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_lifecycle_before BEFORE UPDATE ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.member_lifecycle_before();
CREATE FUNCTION pactaris.member_lifecycle_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.status IN ('left','revoked') AND OLD.status NOT IN ('left','revoked') THEN
   INSERT INTO pactaris.membership_endings(household_id,membership_id,account_id,end_status,ended_at)
    VALUES(NEW.household_id,NEW.id,NEW.account_id,NEW.status,NEW.ended_at) ON CONFLICT DO NOTHING;
 END IF;
 IF NEW.status IN ('left','revoked') OR NEW.technical_role IS DISTINCT FROM OLD.technical_role THEN
   UPDATE pactaris.ownership_offers SET status='invalidated' WHERE household_id=NEW.household_id AND status='pending'
    AND (from_membership_id=NEW.id OR to_membership_id=NEW.id);
 END IF;
 IF NEW.status<>'active' OR NEW.technical_role NOT IN ('owner','admin') THEN
   UPDATE pactaris.invitations SET status='revoked' WHERE household_id=NEW.household_id AND creator_membership_id=NEW.id AND status='pending';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_lifecycle_after AFTER UPDATE OF status,technical_role ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.member_lifecycle_after();
REVOKE ALL ON FUNCTION pactaris.member_lifecycle_after() FROM PUBLIC;

CREATE FUNCTION pactaris.member_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; member pactaris.memberships; other pactaris.memberships; source pactaris.memberships;
 offer pactaris.ownership_offers; receipt pactaris.membership_receipts; answer jsonb; rows jsonb; offers jsonb;
 after_id uuid; next_id uuid; ending uuid;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' OR
   action NOT IN ('memberList','memberAlias','memberRemove','ownerOffer','ownerAccept','ownerDecline','ownerCancel','memberReceipt') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.member.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.membership_receipts WHERE operation_id=operation;
 IF action='memberReceipt' THEN
   IF NOT FOUND THEN RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','missing'); END IF;
   IF receipt.household_id<>target OR receipt.actor_account_id<>actor THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
   RETURN receipt.result;
 END IF;
 IF FOUND THEN
   IF receipt.household_id<>target OR receipt.actor_account_id<>actor OR receipt.actor_membership_id IS DISTINCT FROM (body->>'membershipId')::uuid
     OR receipt.action<>action OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.conflict'; END IF;
   RETURN receipt.result;
 END IF;
 SELECT * INTO member FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
 IF action='memberList' THEN
   after_id=(body->>'after')::uuid;
   SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',m.id,'displayName',m.display_name,'technicalRole',m.technical_role,'isSelf',m.id=member.id,
      'canRemove',m.id<>member.id AND ((member.technical_role='owner' AND m.technical_role<>'owner') OR (member.technical_role='admin' AND m.technical_role='participant')),
      'canOffer',member.technical_role='owner' AND m.id<>member.id AND m.technical_role<>'owner') ORDER BY m.id),'[]'::jsonb)
    INTO rows FROM (SELECT * FROM pactaris.memberships WHERE household_id=target AND status='active' AND (after_id IS NULL OR id>after_id) ORDER BY id LIMIT 20) m;
   IF jsonb_array_length(rows)=20 AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND status='active'
      AND id>(rows->19->>'membershipId')::uuid) THEN next_id=(rows->19->>'membershipId')::uuid; END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'fromMembershipId',o.from_membership_id,'toMembershipId',o.to_membership_id,
      'status',CASE WHEN o.status='pending' AND o.expires_at<=now() THEN 'expired' WHEN o.status='pending' AND o.safety_version<>h.safety_version THEN 'invalidated' ELSE o.status END,
      'expiresAt',o.expires_at) ORDER BY o.created_at DESC),'[]'::jsonb)
     INTO offers FROM (SELECT * FROM pactaris.ownership_offers WHERE household_id=target AND
       (from_membership_id=member.id OR to_membership_id=member.id) ORDER BY (status='pending') DESC,created_at DESC LIMIT 20) o;
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','listed','actorMembershipId',member.id,'members',rows,'offers',offers,'nextCursor',next_id);
 ELSIF action='memberAlias' THEN
   IF body->>'name' IS NULL OR char_length(body->>'name')>80 OR body->>'name'<>btrim(body->>'name') OR body->>'name' ~ '[[:cntrl:]]' THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.invalid'; END IF;
   UPDATE pactaris.memberships SET display_name=body->>'name' WHERE household_id=target AND id=member.id;
   answer='{"status":"applied"}'::jsonb;
 ELSIF action IN ('memberRemove','ownerOffer') THEN
   SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(body->>'targetMembershipId')::uuid AND status='active' FOR UPDATE;
   IF NOT FOUND OR other.id=member.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
   IF action='memberRemove' THEN
     IF NOT ((member.technical_role='owner' AND other.technical_role<>'owner') OR (member.technical_role='admin' AND other.technical_role='participant')) THEN
       RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
     UPDATE pactaris.memberships SET status='revoked' WHERE household_id=target AND id=other.id;
     UPDATE pactaris.households SET safety_version=safety_version+1 WHERE id=target;
     SELECT id INTO ending FROM pactaris.membership_endings WHERE household_id=target AND membership_id=other.id;
     answer=jsonb_build_object('status','applied','targetMembershipId',other.id,'targetAccountId',other.account_id,'endingId',ending);
   ELSE
     IF member.technical_role<>'owner' OR other.technical_role='owner' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
     UPDATE pactaris.ownership_offers SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'invalidated' END
       WHERE household_id=target AND status='pending' AND (expires_at<=now() OR safety_version<>h.safety_version);
     IF EXISTS(SELECT 1 FROM pactaris.ownership_offers WHERE household_id=target AND from_membership_id=member.id AND status='pending') THEN
       RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.conflict'; END IF;
     INSERT INTO pactaris.ownership_offers(id,household_id,from_membership_id,to_membership_id,from_role_version,to_role_version,safety_version)
       VALUES(operation,target,member.id,other.id,member.role_version,other.role_version,h.safety_version);
     answer=jsonb_build_object('status','applied','offerId',operation);
   END IF;
 ELSIF action IN ('ownerAccept','ownerDecline','ownerCancel') THEN
   SELECT * INTO offer FROM pactaris.ownership_offers WHERE id=(body->>'offerId')::uuid AND household_id=target FOR UPDATE;
   IF NOT FOUND OR offer.status<>'pending' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.conflict'; END IF;
   IF action='ownerCancel' THEN
     IF member.id<>offer.from_membership_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
     UPDATE pactaris.ownership_offers SET status='cancelled' WHERE id=offer.id;answer=jsonb_build_object('status','applied','offerId',offer.id);
   ELSE
     IF member.id<>offer.to_membership_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.denied'; END IF;
     IF action='ownerDecline' THEN
       UPDATE pactaris.ownership_offers SET status='declined' WHERE id=offer.id;answer=jsonb_build_object('status','applied','offerId',offer.id);
     ELSE
       SELECT * INTO source FROM pactaris.memberships WHERE household_id=target AND id=offer.from_membership_id AND status='active' FOR UPDATE;
       IF NOT FOUND OR source.technical_role<>'owner' OR source.role_version<>offer.from_role_version OR member.role_version<>offer.to_role_version
         OR member.technical_role='owner' OR offer.expires_at<=now() OR offer.safety_version<>h.safety_version THEN
         RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.conflict'; END IF;
       UPDATE pactaris.ownership_offers SET status='accepted' WHERE id=offer.id;
       UPDATE pactaris.memberships SET technical_role='participant' WHERE household_id=target AND id=source.id;
       UPDATE pactaris.memberships SET technical_role='owner' WHERE household_id=target AND id=member.id;
       answer=jsonb_build_object('status','applied','offerId',offer.id);
     END IF;
   END IF;
 ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='member.invalid';
 END IF;
 answer=answer||jsonb_build_object('householdId',target,'operationId',operation,'action',action,'actorMembershipId',member.id);
 INSERT INTO pactaris.membership_receipts(operation_id,household_id,actor_account_id,actor_membership_id,action,request_hash,result)
   VALUES(operation,target,actor,member.id,action,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'membership.'||action,coalesce((body->>'targetMembershipId')::uuid,(body->>'offerId')::uuid,member.id),
     jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.membership_outbox(operation_id,household_id,event_key) VALUES(operation,target,'membership.'||action);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.member_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
