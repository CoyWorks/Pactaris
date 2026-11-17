ALTER TABLE pactaris.memberships ADD COLUMN safety_paused boolean NOT NULL DEFAULT false,ADD COLUMN safety_epoch bigint NOT NULL DEFAULT 1 CHECK(safety_epoch>0);
CREATE TABLE pactaris.personal_limits (
 household_id uuid NOT NULL,membership_id uuid NOT NULL,version bigint NOT NULL DEFAULT 1,
 limits jsonb NOT NULL DEFAULT '{"hard":"","soft":"","signal":"","aftercare":"","blockedActivities":[]}',
 PRIMARY KEY(household_id,membership_id),FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.relationship_holds (
 household_id uuid NOT NULL,relationship_id uuid NOT NULL,membership_id uuid NOT NULL,paused boolean NOT NULL DEFAULT false,epoch bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(household_id,relationship_id,membership_id),FOREIGN KEY(household_id,relationship_id,membership_id) REFERENCES pactaris.relationship_participants(household_id,relationship_id,membership_id)
);
CREATE TABLE pactaris.household_reentry (
 household_id uuid NOT NULL,membership_id uuid NOT NULL,epoch bigint NOT NULL,PRIMARY KEY(household_id,membership_id),
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.agreements (
 household_id uuid NOT NULL,id uuid NOT NULL,relationship_id uuid NOT NULL,version bigint NOT NULL DEFAULT 1,PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,relationship_id) REFERENCES pactaris.relationships(household_id,id)
);
CREATE TABLE pactaris.agreement_versions (
 household_id uuid NOT NULL,agreement_id uuid NOT NULL,version bigint NOT NULL,terms jsonb NOT NULL,expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(household_id,agreement_id,version),
 FOREIGN KEY(household_id,agreement_id) REFERENCES pactaris.agreements(household_id,id),FOREIGN KEY(household_id,created_by) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.agreement_decisions (
 household_id uuid NOT NULL,agreement_id uuid NOT NULL,version bigint NOT NULL,membership_id uuid NOT NULL,
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','accepted','declined','withdrawn')),
 household_epoch bigint,member_epoch bigint,relationship_epoch bigint,limits_version bigint,decided_at timestamptz,
 PRIMARY KEY(household_id,agreement_id,version,membership_id),FOREIGN KEY(household_id,agreement_id,version) REFERENCES pactaris.agreement_versions(household_id,agreement_id,version),
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.consent_receipts (
 operation_id uuid PRIMARY KEY,household_id uuid NOT NULL,actor_membership_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),result jsonb NOT NULL,
 FOREIGN KEY(household_id,actor_membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.consent_outbox (
 operation_id uuid PRIMARY KEY REFERENCES pactaris.consent_receipts(operation_id),household_id uuid NOT NULL REFERENCES pactaris.households(id),event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pactaris.local_safety_grants (
 id uuid PRIMARY KEY,household_id uuid NOT NULL,membership_id uuid NOT NULL,proof_hash text NOT NULL CHECK(proof_hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['personal_limits','relationship_holds','household_reentry','agreements','agreement_versions','agreement_decisions','consent_receipts','consent_outbox','local_safety_grants'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;
-- Acquires the same lifecycle lock as stop/leave/limits/consent. Future effectful
-- domain commands must call this within their write transaction, not beforehand.
CREATE FUNCTION pactaris.activity_guard(target uuid,instance uuid,actor uuid,member_id uuid,agreement uuid,expected_version bigint,activity text,expected_epoch bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; a pactaris.agreements; v pactaris.agreement_versions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status<>'active' OR h.safety_version IS DISTINCT FROM expected_epoch OR activity IS NULL OR activity NOT IN ('task','protocol','reward','consequence','session','reminder') THEN RETURN false; END IF;
 SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=agreement AND version=expected_version;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=a.relationship_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
   WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND m.id=member_id AND m.account_id=actor AND m.status='active') THEN RETURN false; END IF;
 SELECT * INTO v FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=agreement AND version=expected_version;
 IF NOT FOUND OR v.revoked OR v.expires_at<=now() OR NOT (v.terms->'activities' ? activity) THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
  LEFT JOIN pactaris.personal_limits l ON l.household_id=p.household_id AND l.membership_id=p.membership_id
  LEFT JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.membership_id=p.membership_id
  LEFT JOIN pactaris.agreement_decisions d ON d.household_id=target AND d.agreement_id=agreement AND d.version=expected_version AND d.membership_id=p.membership_id
  WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND (m.status<>'active' OR m.safety_paused OR coalesce(rh.paused,false) OR
   coalesce(l.limits->'blockedActivities','[]'::jsonb) ? activity OR d.decision IS DISTINCT FROM 'accepted' OR d.household_epoch IS DISTINCT FROM h.safety_version OR
   d.member_epoch IS DISTINCT FROM m.safety_epoch OR d.relationship_epoch IS DISTINCT FROM coalesce(rh.epoch,1) OR d.limits_version IS DISTINCT FROM coalesce(l.version,1)));
END $$;
REVOKE ALL ON FUNCTION pactaris.activity_guard(uuid,uuid,uuid,uuid,uuid,bigint,text,bigint) FROM PUBLIC;
CREATE FUNCTION pactaris.consent_command(target uuid,instance uuid,actor uuid,operation uuid,command text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; a pactaris.agreements; v pactaris.agreement_versions; receipt pactaris.consent_receipts;
 act text:=command; input jsonb:=body; answer jsonb; rows jsonb; lim jsonb; limits_ver bigint; rel uuid; rel_epoch bigint; rel_paused boolean; next_id uuid; terms jsonb; new_version bigint;
BEGIN
 IF command IS NULL OR command NOT IN ('consentState','agreementList','agreementPropose','agreementRevise','agreementAccept','agreementDecline','agreementWithdraw','activityCheck','limitsUpdate','selfPause','selfResume','householdStop','householdResume','relationshipPause','relationshipResume','safetyGrant','localRestrict')
  OR target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.consent.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;
 IF command='localRestrict' THEN
  IF NOT EXISTS(SELECT 1 FROM pactaris.local_safety_grants WHERE id=(body->>'ticketId')::uuid AND household_id=target AND membership_id=m.id AND expires_at>now()
   AND proof_hash=encode(sha256(convert_to(body->>'proof','UTF8')),'hex')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;
  input=body->'restriction';act=input->>'action';
  IF act IS NULL OR act NOT IN ('selfPause','householdStop','relationshipPause','agreementWithdraw') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;
 END IF;
 SELECT * INTO receipt FROM pactaris.consent_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>m.id OR receipt.request_hash<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT limits,version INTO lim,limits_ver FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id;
 lim=coalesce(lim,'{"hard":"","soft":"","signal":"","aftercare":"","blockedActivities":[]}'::jsonb);limits_ver=coalesce(limits_ver,1);
 IF act='consentState' THEN
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','state',
   jsonb_build_object('epoch',h.safety_version::text,'memberEpoch',m.safety_epoch::text,'householdStatus',h.status,'selfPaused',m.safety_paused,'limitsVersion',limits_ver::text,'limits',lim,
    'resumeAcknowledged',EXISTS(SELECT 1 FROM pactaris.household_reentry WHERE household_id=target AND membership_id=m.id AND epoch=h.safety_version)));
 ELSIF act IN ('agreementList','agreementPropose','relationshipPause','relationshipResume') THEN rel=(input->>'relationshipId')::uuid;
 ELSIF act IN ('agreementRevise','agreementAccept','agreementDecline','agreementWithdraw','activityCheck') THEN
  SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=(input->>'agreementId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;rel=a.relationship_id;
 END IF;
 IF rel IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM pactaris.relationships r JOIN pactaris.relationship_participants p ON p.household_id=r.household_id AND p.relationship_id=r.id
    WHERE r.household_id=target AND r.id=rel AND r.proposer_membership_id IS NOT NULL AND p.membership_id=m.id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.denied'; END IF;
  SELECT epoch,paused INTO rel_epoch,rel_paused FROM pactaris.relationship_holds WHERE household_id=target AND relationship_id=rel AND membership_id=m.id;
  rel_epoch=coalesce(rel_epoch,1);rel_paused=coalesce(rel_paused,false);
 END IF;
 IF act='agreementList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('agreementId',g.id,'relationshipId',g.relationship_id,'version',g.version::text,'terms',av.terms,'expiresAt',av.expires_at,'revoked',av.revoked,
   'decisions',(SELECT jsonb_agg(jsonb_build_object('membershipId',d.membership_id,'decision',d.decision,'current',d.decision='accepted' AND h.status='active' AND EXISTS(SELECT 1 FROM pactaris.relationships r WHERE r.household_id=target AND r.id=rel AND r.status='active') AND NOT av.revoked AND av.expires_at>now() AND
    d.household_epoch=h.safety_version AND d.member_epoch=mem.safety_epoch AND d.relationship_epoch=coalesce(rh.epoch,1) AND d.limits_version=coalesce(l.version,1) AND NOT mem.safety_paused AND NOT coalesce(rh.paused,false) AND mem.status='active') ORDER BY d.membership_id)
    FROM pactaris.agreement_decisions d JOIN pactaris.memberships mem ON mem.household_id=d.household_id AND mem.id=d.membership_id
    LEFT JOIN pactaris.personal_limits l ON l.household_id=d.household_id AND l.membership_id=d.membership_id
    LEFT JOIN pactaris.relationship_holds rh ON rh.household_id=d.household_id AND rh.relationship_id=rel AND rh.membership_id=d.membership_id
    WHERE d.household_id=target AND d.agreement_id=g.id AND d.version=g.version)) ORDER BY g.id),'[]'::jsonb) INTO rows
   FROM (SELECT * FROM pactaris.agreements WHERE household_id=target AND relationship_id=rel AND (input->>'after' IS NULL OR id>(input->>'after')::uuid) ORDER BY id LIMIT 1) g
   JOIN pactaris.agreement_versions av ON av.household_id=g.household_id AND av.agreement_id=g.id AND av.version=g.version;
  IF jsonb_array_length(rows)=1 AND EXISTS(SELECT 1 FROM pactaris.agreements WHERE household_id=target AND relationship_id=rel AND id>(rows->0->>'agreementId')::uuid) THEN next_id=(rows->0->>'agreementId')::uuid; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','agreements',rows,'relationshipEpoch',rel_epoch::text,'relationshipPaused',rel_paused,'nextCursor',next_id);
 ELSIF act IN ('agreementPropose','agreementRevise') THEN
  terms=input->'terms';
  IF h.status<>'active' OR NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=rel AND status='active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  IF jsonb_typeof(terms) IS DISTINCT FROM 'object' OR jsonb_typeof(terms->'activities') IS DISTINCT FROM 'array' OR jsonb_array_length(terms->'activities') NOT BETWEEN 1 AND 6 OR
   (terms->>'validHours')::int NOT BETWEEN 1 AND 720 OR (terms->>'validHours') IS NULL OR terms->>'label' IS NULL OR char_length(terms->>'label') NOT BETWEEN 1 AND 80 OR
   EXISTS(SELECT 1 FROM jsonb_array_elements_text(terms->'activities') c WHERE c NOT IN ('task','protocol','reward','consequence','session','reminder')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.invalid'; END IF;
  IF act='agreementPropose' THEN
   INSERT INTO pactaris.agreements(household_id,id,relationship_id) VALUES(target,operation,rel) RETURNING * INTO a;
  ELSE
   IF a.version::text IS DISTINCT FROM input->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
   UPDATE pactaris.agreements SET version=version+1 WHERE household_id=target AND id=a.id RETURNING * INTO a;
  END IF;
  INSERT INTO pactaris.agreement_versions(household_id,agreement_id,version,terms,expires_at,created_by)
   VALUES(target,a.id,a.version,terms,now()+((terms->>'validHours')::int*interval '1 hour'),m.id);
  INSERT INTO pactaris.agreement_decisions(household_id,agreement_id,version,membership_id)
   SELECT target,a.id,a.version,membership_id FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=rel;
 ELSIF act IN ('agreementAccept','agreementDecline','agreementWithdraw','activityCheck') THEN
  IF a.version::text IS DISTINCT FROM input->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  SELECT * INTO v FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=a.id AND version=a.version;
  IF act='activityCheck' THEN
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','eligible',pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,input->>'activity',(input->>'epoch')::bigint));
  ELSIF act='agreementAccept' THEN
   IF h.status<>'active' OR m.safety_paused OR rel_paused OR v.revoked OR v.expires_at<=now() OR h.safety_version::text IS DISTINCT FROM input->>'epoch' OR
    m.safety_epoch::text IS DISTINCT FROM input->>'memberEpoch' OR rel_epoch::text IS DISTINCT FROM input->>'relationshipEpoch' OR limits_ver::text IS DISTINCT FROM input->>'limitsVersion' OR
    NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=rel AND status='active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
   UPDATE pactaris.agreement_decisions SET decision='accepted',household_epoch=h.safety_version,member_epoch=m.safety_epoch,relationship_epoch=rel_epoch,limits_version=limits_ver,decided_at=statement_timestamp()
    WHERE household_id=target AND agreement_id=a.id AND version=a.version AND membership_id=m.id;
  ELSE
   UPDATE pactaris.agreement_decisions SET decision=CASE WHEN act='agreementDecline' THEN 'declined' ELSE 'withdrawn' END,decided_at=statement_timestamp()
    WHERE household_id=target AND agreement_id=a.id AND version=a.version AND membership_id=m.id;
   UPDATE pactaris.agreement_versions SET revoked=true WHERE household_id=target AND agreement_id=a.id AND version=a.version;
  END IF;
 ELSIF act='limitsUpdate' THEN
  IF limits_ver::text IS DISTINCT FROM input->>'limitsVersion' OR jsonb_typeof(input->'limits') IS DISTINCT FROM 'object' OR jsonb_typeof(input->'limits'->'blockedActivities') IS DISTINCT FROM 'array' OR
   EXISTS(SELECT 1 FROM jsonb_array_elements_text(input->'limits'->'blockedActivities') c WHERE c NOT IN ('task','protocol','reward','consequence','session','reminder')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  INSERT INTO pactaris.personal_limits(household_id,membership_id,version,limits) VALUES(target,m.id,limits_ver+1,input->'limits')
   ON CONFLICT(household_id,membership_id) DO UPDATE SET version=EXCLUDED.version,limits=EXCLUDED.limits;
 ELSIF act='selfPause' THEN
  UPDATE pactaris.memberships SET safety_paused=true,safety_epoch=safety_epoch+1 WHERE household_id=target AND id=m.id;
  DELETE FROM pactaris.household_reentry WHERE household_id=target AND membership_id=m.id;
 ELSIF act IN ('selfResume','householdResume') THEN
  IF h.safety_version::text IS DISTINCT FROM input->>'epoch' OR m.safety_epoch::text IS DISTINCT FROM input->>'memberEpoch' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  IF act='selfResume' THEN
   UPDATE pactaris.memberships SET safety_paused=false,safety_epoch=safety_epoch+1 WHERE household_id=target AND id=m.id;
  ELSE
   IF m.safety_paused OR h.status<>'paused' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
   INSERT INTO pactaris.household_reentry VALUES(target,m.id,h.safety_version) ON CONFLICT(household_id,membership_id) DO UPDATE SET epoch=EXCLUDED.epoch;
   IF EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND status='active' AND technical_role='owner') AND NOT EXISTS(
    SELECT 1 FROM pactaris.memberships mem WHERE mem.household_id=target AND mem.status='active' AND (mem.safety_paused OR NOT EXISTS(
     SELECT 1 FROM pactaris.household_reentry e WHERE e.household_id=target AND e.membership_id=mem.id AND e.epoch=h.safety_version))) THEN
    UPDATE pactaris.households SET status='active' WHERE id=target;
   END IF;
  END IF;
 ELSIF act='householdStop' THEN
  UPDATE pactaris.households SET status='paused',safety_version=safety_version+1 WHERE id=target;
 ELSIF act IN ('relationshipPause','relationshipResume') THEN
  IF act='relationshipResume' AND (h.safety_version::text IS DISTINCT FROM input->>'epoch' OR m.safety_epoch::text IS DISTINCT FROM input->>'memberEpoch' OR rel_epoch::text IS DISTINCT FROM input->>'relationshipEpoch') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.conflict'; END IF;
  INSERT INTO pactaris.relationship_holds(household_id,relationship_id,membership_id,paused,epoch) VALUES(target,rel,m.id,act='relationshipPause',rel_epoch+1)
   ON CONFLICT(household_id,relationship_id,membership_id) DO UPDATE SET paused=EXCLUDED.paused,epoch=EXCLUDED.epoch;
 ELSIF act='safetyGrant' THEN
  IF body->>'proofHash' IS NULL OR body->>'proofHash'!~'^[a-f0-9]{64}$' OR (body->>'validSeconds')::int NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.invalid'; END IF;
  INSERT INTO pactaris.local_safety_grants VALUES(operation,target,m.id,body->>'proofHash',now()+((body->>'validSeconds')::int*interval '1 second'));
  SELECT jsonb_build_object('expiresAt',expires_at) INTO answer FROM pactaris.local_safety_grants WHERE id=operation;
 ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='consent.invalid'; END IF;
 answer=coalesce(answer,'{}'::jsonb)||jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied');
 IF a.id IS NOT NULL THEN answer=answer||jsonb_build_object('agreementId',a.id,'version',a.version::text); END IF;
 INSERT INTO pactaris.consent_receipts VALUES(operation,target,m.id,fingerprint,answer);
 IF act<>'safetyGrant' THEN
  INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
   VALUES(target,gen_random_uuid(),actor,'consent.'||act,coalesce(a.id,rel,m.id),jsonb_build_object('operationId',operation));
  INSERT INTO pactaris.consent_outbox(operation_id,household_id,event_key) VALUES(operation,target,'consent.'||act);
 END IF;
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.consent_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
