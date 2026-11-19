ALTER TABLE pactaris.households
 ADD COLUMN points_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN points_label text CHECK (
  points_label IS NULL OR (
   char_length(points_label) BETWEEN 1 AND 32 AND points_label=btrim(points_label)
   AND points_label !~ '[[:cntrl:]]'
  )
 );

CREATE FUNCTION pactaris.workspace_points(target uuid, instance uuid, actor uuid, operation uuid, action text, body jsonb, fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE household pactaris.households; member pactaris.memberships; receipt pactaris.workspace_receipts;
 settings jsonb; answer jsonb;
BEGIN
 IF action NOT IN ('read','configure') OR action IS NULL OR fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
 END IF;
 IF action='configure' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.workspace.operation.'||operation::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 END IF;
 SELECT * INTO household FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO member FROM pactaris.memberships
 WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF action='read' THEN
  RETURN jsonb_build_object('enabled',household.points_enabled,'label',household.points_label);
 END IF;
 IF member.technical_role NOT IN ('owner','admin') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.workspace_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_membership_id<>member.id OR receipt.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';
  END IF;
  RETURN receipt.result;
 END IF;
 IF household.settings_version::text IS DISTINCT FROM body->>'version' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict';
 END IF;
 settings=body->'pointsSettings';
 IF jsonb_typeof(settings->'enabled') IS DISTINCT FROM 'boolean'
  OR NOT coalesce(jsonb_typeof(settings->'label') IN ('null','string'),false)
  OR (settings->>'label' IS NOT NULL AND (char_length(settings->>'label') NOT BETWEEN 1 AND 32
      OR settings->>'label'<>btrim(settings->>'label') OR settings->>'label'~'[[:cntrl:]]')) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
 END IF;
 UPDATE pactaris.households SET points_enabled=(settings->>'enabled')::boolean,
  points_label=settings->>'label', settings_version=settings_version+1 WHERE id=target;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',member.id,'status','applied');
 INSERT INTO pactaris.workspace_receipts VALUES(operation,target,member.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
 VALUES(target,gen_random_uuid(),actor,'workspace.pointsConfigure',target,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.workspace_outbox VALUES(operation,target,'workspace.pointsConfigure',now());
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.workspace_points(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

ALTER FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) RENAME TO partner_command_before_point_settings;
DO $$
DECLARE grantee text;
BEGIN
 FOR grantee IN SELECT rolname FROM pg_roles WHERE
  has_function_privilege(oid,'pactaris.partner_command_before_point_settings(uuid,uuid,uuid,uuid,text,jsonb,text)','EXECUTE')
  AND rolname<>current_user AND NOT rolsuper LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION pactaris.partner_command_before_point_settings(uuid,uuid,uuid,uuid,text,jsonb,text) FROM %I',grantee);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF action IN ('partnerOffer','partnerAssign','partnerSeriesCreate','partnerSeriesUpdate')
    AND payload->'fields'?'rewardPoints' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
  IF NOT EXISTS(SELECT 1 FROM pactaris.partner_receipts WHERE operation_id=operation)
     AND EXISTS(SELECT 1 FROM pactaris.households h JOIN pactaris.memberships m ON m.household_id=h.id
      WHERE h.id=target AND h.instance_id=instance AND h.status<>'closed' AND NOT h.points_enabled
       AND m.account_id=actor AND m.status='active' AND m.id=(payload->>'membershipId')::uuid) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.conflict';
  END IF;
 END IF;
 RETURN pactaris.partner_command_before_point_settings(target,instance,actor,operation,action,payload,fingerprint);
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
