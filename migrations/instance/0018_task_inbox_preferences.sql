CREATE TABLE pactaris.task_inbox_preferences (
 household_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 assigned boolean NOT NULL,
 submitted boolean NOT NULL,
 reviewed boolean NOT NULL,
 PRIMARY KEY(household_id,membership_id),
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.task_inbox_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.task_inbox_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.task_inbox_preferences
 USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.apply_task_inbox_preferences() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE enabled boolean;
BEGIN
 SELECT CASE NEW.kind WHEN 'assigned' THEN p.assigned WHEN 'submitted' THEN p.submitted WHEN 'reviewed' THEN p.reviewed END
 INTO enabled FROM pactaris.task_inbox_preferences p
 WHERE p.household_id=NEW.household_id AND p.membership_id=NEW.recipient;
 IF enabled IS FALSE THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.apply_task_inbox_preferences() FROM PUBLIC;
CREATE TRIGGER task_inbox_preference BEFORE INSERT ON pactaris.task_inbox
 FOR EACH ROW EXECUTE FUNCTION pactaris.apply_task_inbox_preferences();

CREATE FUNCTION pactaris.task_inbox_preference_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE member uuid; prefs jsonb; response_status text;
BEGIN
 IF action NOT IN ('partnerInboxPreferences','partnerInboxConfigure') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT m.id INTO member FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
 WHERE h.id=target AND h.instance_id=instance AND h.status<>'closed' AND m.id=(payload->>'membershipId')::uuid
   AND m.account_id=actor AND m.status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;

 IF action='partnerInboxConfigure' THEN
  prefs=payload->'preferences';
  IF jsonb_typeof(prefs) IS DISTINCT FROM 'object' OR prefs - 'assigned' - 'submitted' - 'reviewed' <> '{}'::jsonb
   OR jsonb_typeof(prefs->'assigned') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(prefs->'submitted') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(prefs->'reviewed') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
  END IF;
  INSERT INTO pactaris.task_inbox_preferences(household_id,membership_id,assigned,submitted,reviewed)
  VALUES(target,member,(prefs->>'assigned')::boolean,(prefs->>'submitted')::boolean,(prefs->>'reviewed')::boolean)
  ON CONFLICT(household_id,membership_id) DO UPDATE SET assigned=EXCLUDED.assigned,submitted=EXCLUDED.submitted,reviewed=EXCLUDED.reviewed;
  response_status='applied';
 ELSE
  SELECT jsonb_build_object('assigned',p.assigned,'submitted',p.submitted,'reviewed',p.reviewed) INTO prefs
  FROM pactaris.task_inbox_preferences p WHERE p.household_id=target AND p.membership_id=member;
  prefs=coalesce(prefs,'{"assigned":true,"submitted":true,"reviewed":true}'::jsonb);
  response_status='listed';
 END IF;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',member,
  'status',response_status,'inboxPreferences',prefs);
END $$;
REVOKE ALL ON FUNCTION pactaris.task_inbox_preference_command(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
