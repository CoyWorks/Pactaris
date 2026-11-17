-- Existing scaffold-only rows remain private and are not silently treated as agreements.
ALTER TABLE pactaris.relationships ADD COLUMN proposer_membership_id uuid,
 ADD COLUMN scope text NOT NULL DEFAULT '' CHECK(char_length(scope)<=500),
 ADD COLUMN ended_at timestamptz, ADD COLUMN end_reason text CHECK(end_reason IN ('declined','withdrawn','membershipEnded')),
 ADD FOREIGN KEY(household_id,proposer_membership_id) REFERENCES pactaris.memberships(household_id,id);
ALTER TABLE pactaris.relationship_participants ADD COLUMN decision text NOT NULL DEFAULT 'pending'
 CHECK(decision IN ('pending','accepted','declined','withdrawn')),ADD COLUMN decided_at timestamptz;
CREATE TABLE pactaris.relationship_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,actor_account_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.relationship_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.relationship_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),
 event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz
);
ALTER TABLE pactaris.relationship_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_receipts_command ON pactaris.relationship_receipts FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY relationship_outbox_command ON pactaris.relationship_outbox FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
-- No direct runtime grants: only this reviewed command surface reads intimate graph content.
CREATE POLICY relationships_command ON pactaris.relationships FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY relationship_participants_command ON pactaris.relationship_participants FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY relationship_roles_command ON pactaris.relationship_roles FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE POLICY dynamic_roles_command ON pactaris.dynamic_roles FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
CREATE FUNCTION pactaris.relationship_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.relationships r SET status='ended',ended_at=statement_timestamp(),end_reason='membershipEnded'
   WHERE r.household_id=NEW.household_id AND r.proposer_membership_id IS NOT NULL AND r.status<>'ended'
    AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=r.household_id AND p.relationship_id=r.id AND p.membership_id=NEW.id);
  UPDATE pactaris.relationship_participants SET decision='withdrawn',accepted=false,decided_at=statement_timestamp()
   WHERE household_id=NEW.household_id AND membership_id=NEW.id AND EXISTS(SELECT 1 FROM pactaris.relationships r
    WHERE r.household_id=NEW.household_id AND r.id=relationship_id AND r.proposer_membership_id IS NOT NULL);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER relationship_departure AFTER UPDATE OF status ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.relationship_departure();
REVOKE ALL ON FUNCTION pactaris.relationship_departure() FROM PUBLIC;
CREATE FUNCTION pactaris.relationship_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; member pactaris.memberships; r pactaris.relationships; receipt pactaris.relationship_receipts;
 answer jsonb; listing jsonb; proposal jsonb; role jsonb; role_id uuid; relation_id uuid; participant uuid; after_id uuid; next_id uuid;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$'
  OR action IS NULL OR action NOT IN ('relationshipList','relationshipPropose','relationshipAccept','relationshipDecline','relationshipWithdraw') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.relationship.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
 SELECT * INTO member FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.relationship_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_account_id<>actor OR receipt.actor_membership_id<>member.id OR receipt.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
  RETURN receipt.result;
 END IF;
 IF action='relationshipList' THEN
  after_id=(body->>'after')::uuid;
  SELECT coalesce(jsonb_agg(jsonb_build_object('relationshipId',v.id,'version',v.version::text,'label',v.label,'scope',v.scope,'status',v.status,'endReason',v.end_reason,
   'participants',(SELECT jsonb_agg(jsonb_build_object('membershipId',p.membership_id,'displayName',m.display_name,'decision',p.decision) ORDER BY p.membership_id)
    FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
    WHERE p.household_id=target AND p.relationship_id=v.id),
   'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',rr.membership_id,'label',d.label,'counterpartMembershipId',rr.counterpart_membership_id,'context',rr.context) ORDER BY rr.id),'[]'::jsonb)
    FROM pactaris.relationship_roles rr JOIN pactaris.dynamic_roles d ON d.household_id=rr.household_id AND d.id=rr.role_id WHERE rr.household_id=target AND rr.relationship_id=v.id)) ORDER BY v.id),'[]'::jsonb)
   INTO listing FROM (SELECT rel.* FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.proposer_membership_id IS NOT NULL
    AND (after_id IS NULL OR rel.id>after_id) AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id)
    ORDER BY rel.id LIMIT 1) v;
  IF jsonb_array_length(listing)=1 AND EXISTS(SELECT 1 FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.proposer_membership_id IS NOT NULL
   AND rel.id>(listing->0->>'relationshipId')::uuid AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id)) THEN
   next_id=(listing->0->>'relationshipId')::uuid; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','listed','actorMembershipId',member.id,'relationships',listing,'nextCursor',next_id);
 END IF;
 IF action='relationshipPropose' THEN
  proposal=body->'proposal';
  IF h.status<>'active' OR jsonb_typeof(proposal)<>'object' OR char_length(proposal->>'label') NOT BETWEEN 1 AND 80 OR proposal->>'label'<>btrim(proposal->>'label')
   OR char_length(proposal->>'scope')>500 OR proposal->>'scope' IS NULL OR jsonb_typeof(proposal->'participants')<>'array'
   OR jsonb_array_length(proposal->'participants') NOT BETWEEN 2 AND 8 OR jsonb_typeof(proposal->'roles')<>'array' OR jsonb_array_length(proposal->'roles')>8 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
  IF (SELECT count(DISTINCT v::uuid) FROM jsonb_array_elements_text(proposal->'participants') v)<>jsonb_array_length(proposal->'participants') OR
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposal->'participants') v WHERE v::uuid=member.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
  FOR participant IN SELECT v::uuid FROM jsonb_array_elements_text(proposal->'participants') v LOOP
   IF NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=participant AND status='active') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
  END LOOP;
  relation_id=operation;
  INSERT INTO pactaris.relationships(household_id,id,label,proposer_membership_id,scope) VALUES(target,relation_id,proposal->>'label',member.id,proposal->>'scope');
  INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id)
   SELECT target,relation_id,v::uuid FROM jsonb_array_elements_text(proposal->'participants') v;
  FOR role IN SELECT v FROM jsonb_array_elements(proposal->'roles') v LOOP
   IF char_length(role->>'label') NOT BETWEEN 1 AND 80 OR role->>'label' IS NULL OR role->>'context' IS NULL OR char_length(role->>'context')>160 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
   role_id=gen_random_uuid();
   INSERT INTO pactaris.dynamic_roles(household_id,id,label) VALUES(target,role_id,role->>'label');
   INSERT INTO pactaris.relationship_roles(household_id,id,relationship_id,membership_id,role_id,counterpart_membership_id,context)
    VALUES(target,gen_random_uuid(),relation_id,(role->>'membershipId')::uuid,role_id,(role->>'counterpartMembershipId')::uuid,role->>'context');
  END LOOP;
 ELSE
  SELECT rel.* INTO r FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.id=(body->>'relationshipId')::uuid AND rel.proposer_membership_id IS NOT NULL
   AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
  IF r.version::text IS DISTINCT FROM body->>'version' OR r.status='ended' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
  relation_id=r.id;
  IF action='relationshipAccept' THEN
   IF h.status<>'active' OR r.status<>'proposed' OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id AND decision='pending')
    OR EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
      WHERE p.household_id=target AND p.relationship_id=r.id AND m.status<>'active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
   UPDATE pactaris.relationship_participants SET accepted=true,decision='accepted',decided_at=statement_timestamp() WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id;
   IF NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND decision<>'accepted') THEN
    UPDATE pactaris.relationships SET status='active' WHERE household_id=target AND id=r.id;
   END IF;
  ELSE
   IF action='relationshipDecline' AND (r.status<>'proposed' OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id AND decision='pending')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
   UPDATE pactaris.relationship_participants SET accepted=false,decision=CASE WHEN action='relationshipDecline' THEN 'declined' ELSE 'withdrawn' END,decided_at=statement_timestamp()
    WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id;
   UPDATE pactaris.relationships SET status='ended',ended_at=statement_timestamp(),end_reason=CASE WHEN action='relationshipDecline' THEN 'declined' ELSE 'withdrawn' END WHERE household_id=target AND id=r.id;
  END IF;
 END IF;
 -- The receipt confirms a past command, never current relationship state or consent.
 answer=jsonb_build_object('householdId',target,'operationId',operation,'status','applied','actorMembershipId',member.id,'relationshipId',relation_id);
 INSERT INTO pactaris.relationship_receipts VALUES(operation,target,member.id,actor,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'relationship.'||action,relation_id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.relationship_outbox(operation_id,household_id,event_key) VALUES(operation,target,'relationship.'||action);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.relationship_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
