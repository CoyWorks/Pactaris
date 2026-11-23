-- Push must also honor a pause by participants in system-generated notices.
-- In-app history keeps its existing visibility while delivery is suppressed.
CREATE FUNCTION pactaris.notice_push_visible(target uuid,recipient uuid,notice_kind text,resource uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT pactaris.notice_visible(target,recipient,notice_kind,resource) AND CASE
  WHEN notice_kind='habit' THEN EXISTS (
   SELECT 1 FROM pactaris.authority_habits h JOIN pactaris.memberships holder ON holder.household_id=h.household_id AND holder.id=h.holder_id
   WHERE h.household_id=target AND h.id=resource AND holder.status='active' AND NOT holder.safety_paused)
  WHEN notice_kind='approval' THEN EXISTS (
   SELECT 1 FROM pactaris.partner_tasks t JOIN pactaris.memberships creator ON creator.household_id=t.household_id AND creator.id=t.creator_id
    JOIN pactaris.memberships assignee ON assignee.household_id=t.household_id AND assignee.id=t.assignee_id
   WHERE t.household_id=target AND t.id=resource AND creator.status='active' AND NOT creator.safety_paused AND assignee.status='active' AND NOT assignee.safety_paused)
  ELSE true END
$$;
REVOKE ALL ON FUNCTION pactaris.notice_push_visible(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pactaris.task_delivery_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; m pactaris.memberships; pref pactaris.task_delivery_preferences;
 response jsonb; settings jsonb; current_time_local time; candidate record; notice_seq bigint;
BEGIN
 IF action IS NULL OR action NOT IN ('partnerDeliveryPreferences','partnerDeliveryConfigure','partnerPushStatus') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
 response=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed');
 IF action='partnerDeliveryConfigure' THEN
  settings=payload->'deliveryPreferences';
  IF jsonb_typeof(settings->'push') IS DISTINCT FROM 'boolean' OR jsonb_typeof(settings->'reminders') IS DISTINCT FROM 'boolean'
   OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=settings->>'timeZone')
   OR ((settings->>'quietStart' IS NULL)<>(settings->>'quietEnd' IS NULL))
   OR settings->>'quietStart'=settings->>'quietEnd' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.invalid';
  END IF;
  INSERT INTO pactaris.task_delivery_preferences AS p
   (household_id,member_id,push_enabled,reminders,enabled_at,quiet_start,quiet_end,time_zone)
   VALUES(target,m.id,(settings->>'push')::boolean,(settings->>'reminders')::boolean,
    CASE WHEN (settings->>'push')::boolean THEN clock_timestamp() END,
    (settings->>'quietStart')::time,(settings->>'quietEnd')::time,settings->>'timeZone')
  ON CONFLICT(household_id,member_id) DO UPDATE SET push_enabled=EXCLUDED.push_enabled,reminders=EXCLUDED.reminders,
   quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,time_zone=EXCLUDED.time_zone,
   enabled_at=CASE WHEN EXCLUDED.push_enabled AND p.push_enabled THEN p.enabled_at ELSE EXCLUDED.enabled_at END;
  response=response||jsonb_build_object('status','applied');
 END IF;
 SELECT * INTO pref FROM pactaris.task_delivery_preferences WHERE household_id=target AND member_id=m.id;
 IF action<>'partnerPushStatus' THEN
  RETURN response||jsonb_build_object('deliveryPreferences',jsonb_build_object('push',coalesce(pref.push_enabled,false),'reminders',coalesce(pref.reminders,false),
   'quietStart',to_char(date '2000-01-01'+pref.quiet_start,'HH24:MI'),'quietEnd',to_char(date '2000-01-01'+pref.quiet_end,'HH24:MI'),'timeZone',coalesce(pref.time_zone,h.time_zone)));
 END IF;
 IF NOT coalesce(pref.push_enabled,false) OR h.status<>'active' OR m.safety_paused THEN
  RETURN response||jsonb_build_object('pushSequence',NULL);
 END IF;
 current_time_local=(now() AT TIME ZONE pref.time_zone)::time;
 IF pref.quiet_start IS NOT NULL AND
  (CASE WHEN pref.quiet_start<pref.quiet_end THEN current_time_local>=pref.quiet_start AND current_time_local<pref.quiet_end
   ELSE current_time_local>=pref.quiet_start OR current_time_local<pref.quiet_end END) THEN
  RETURN response||jsonb_build_object('pushSequence',NULL);
 END IF;
 SELECT max(n.push_seq) INTO notice_seq FROM pactaris.member_notices n WHERE n.household_id=target AND n.recipient_id=m.id AND NOT n.read AND pactaris.notice_push_visible(target,m.id,n.kind,n.resource_id)
  AND (n.actor_id IS NULL OR EXISTS(SELECT 1 FROM pactaris.memberships nm WHERE nm.household_id=target AND nm.id=n.actor_id AND nm.status='active' AND NOT nm.safety_paused))
  AND NOT EXISTS(SELECT 1 FROM pactaris.notice_preferences np WHERE np.household_id=target AND np.member_id=m.id AND (n.kind=ANY(np.muted) OR n.actor_id=ANY(np.muted_people)))
  AND n.push_seq>(payload->>'pushAfter')::bigint
  AND n.pushed_eligible_since>=greatest((payload->>'pushSince')::timestamptz,pref.enabled_at,now()-interval '24 hours');
 FOR candidate IN SELECT i.push_seq,i.kind,t.agreement_id,t.agreement_version,t.policy_id,t.policy_version
  FROM pactaris.task_inbox i JOIN pactaris.partner_tasks t ON t.household_id=i.household_id AND t.id=i.task_id
  LEFT JOIN pactaris.task_inbox_preferences p ON p.household_id=i.household_id AND p.membership_id=i.recipient
  WHERE NOT EXISTS(SELECT 1 FROM pactaris.notice_preferences np JOIN pactaris.partner_receipts pr ON pr.household_id=np.household_id AND pr.operation_id=i.id WHERE np.household_id=target AND np.member_id=m.id AND pr.actor_membership_id=ANY(np.muted_people))
   AND i.household_id=target AND i.recipient=m.id AND NOT i.read AND i.push_seq>(payload->>'pushAfter')::bigint
   AND i.pushed_eligible_since>=greatest((payload->>'pushSince')::timestamptz,pref.enabled_at,now()-interval '24 hours')
   AND t.state NOT IN ('declined','cancelled')
   AND CASE i.kind WHEN 'assigned' THEN coalesce(p.assigned,true) WHEN 'submitted' THEN coalesce(p.submitted,true)
    WHEN 'reviewed' THEN coalesce(p.reviewed,true) ELSE pref.reminders END
  ORDER BY i.push_seq DESC LIMIT 25 LOOP
  IF (candidate.kind='reviewed' OR candidate.policy_id IS NULL OR EXISTS(SELECT 1 FROM pactaris.assignment_policies
   WHERE household_id=target AND id=candidate.policy_id AND version=candidate.policy_version AND state='active'))
   AND pactaris.activity_guard(target,instance,actor,m.id,candidate.agreement_id,candidate.agreement_version,
    CASE WHEN candidate.kind='reminder' THEN 'reminder' ELSE 'task' END,h.safety_version) THEN
   RETURN response||jsonb_build_object('pushSequence',greatest(candidate.push_seq,coalesce(notice_seq,0))::text);
  END IF;
 END LOOP;
 RETURN response||jsonb_build_object('pushSequence',notice_seq::text);
END $$;

