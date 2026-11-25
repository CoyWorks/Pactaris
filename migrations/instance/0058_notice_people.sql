-- Per-recipient sender preferences; system-generated notices remain unaffected.
ALTER TABLE pactaris.notice_preferences ADD COLUMN muted_people uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(muted_people)<=100);
CREATE OR REPLACE FUNCTION pactaris.notice(target uuid,recipient uuid,actor uuid,notice_kind text,resource uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.member_notices(household_id,recipient_id,actor_id,kind,resource_id)
 SELECT target,recipient,actor,notice_kind,resource
 WHERE recipient IS DISTINCT FROM actor AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=recipient AND status='active')
  AND NOT EXISTS(SELECT 1 FROM pactaris.notice_preferences p WHERE p.household_id=target AND p.member_id=recipient AND (notice_kind=ANY(p.muted) OR actor=ANY(p.muted_people)))
$$;
CREATE FUNCTION pactaris.task_inbox_sender_preference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE sender uuid;
BEGIN
 SELECT actor_membership_id INTO sender FROM pactaris.partner_receipts WHERE household_id=NEW.household_id AND operation_id=NEW.id;
 IF sender IS NOT NULL AND EXISTS(SELECT 1 FROM pactaris.notice_preferences WHERE household_id=NEW.household_id AND member_id=NEW.recipient AND sender=ANY(muted_people)) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.task_inbox_sender_preference() FROM PUBLIC;
CREATE TRIGGER task_inbox_sender_preference BEFORE INSERT ON pactaris.task_inbox FOR EACH ROW EXECUTE FUNCTION pactaris.task_inbox_sender_preference();
CREATE FUNCTION pactaris.notice_people_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF (OLD.status='active' AND NEW.status<>'active') OR (OLD.account_erased_at IS NULL AND NEW.account_erased_at IS NOT NULL) THEN
  DELETE FROM pactaris.notice_preferences WHERE household_id=NEW.household_id AND member_id=NEW.id;
  UPDATE pactaris.notice_preferences SET muted_people=array_remove(muted_people,NEW.id) WHERE household_id=NEW.household_id AND NEW.id=ANY(muted_people);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.notice_people_departure() FROM PUBLIC;
CREATE TRIGGER notice_people_departure AFTER UPDATE OF status,account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.notice_people_departure();

CREATE OR REPLACE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;chosen text[];people uuid[];next_id uuid;
BEGIN
 IF action IS NULL OR action NOT IN ('noticeList','noticeRead','noticePreferences','noticeConfigure') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action IN ('noticePreferences','noticeConfigure') THEN
  IF action='noticeConfigure' THEN
   IF jsonb_typeof(payload->'muted')<>'array' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO chosen FROM jsonb_array_elements_text(payload->'muted') k;
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer','approval']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   IF payload ? 'mutedPeople' THEN
    IF jsonb_typeof(payload->'mutedPeople') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'mutedPeople')>100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
    SELECT coalesce(array_agg(DISTINCT k::uuid ORDER BY k::uuid),'{}') INTO people FROM jsonb_array_elements_text(payload->'mutedPeople') k;
    IF m.id=ANY(people) OR EXISTS(SELECT 1 FROM unnest(people) p WHERE NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=p AND status='active')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   END IF;
   INSERT INTO pactaris.notice_preferences(household_id,member_id,muted) VALUES(target,m.id,chosen)
    ON CONFLICT(household_id,member_id) DO UPDATE SET muted=EXCLUDED.muted,version=pactaris.notice_preferences.version+1;
   IF payload ? 'mutedPeople' THEN UPDATE pactaris.notice_preferences SET muted_people=people WHERE household_id=target AND member_id=m.id; END IF;
  END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticePreferences' THEN 'listed' ELSE 'applied' END,
   'muted',to_jsonb(coalesce((SELECT muted FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::text[])),
   'mutedPeople',to_jsonb(coalesce((SELECT muted_people FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::uuid[])),
   'people',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.display_name) ORDER BY v.display_name,v.id),'[]'::jsonb) FROM
    (SELECT DISTINCT other.id,other.display_name FROM pactaris.relationship_participants own JOIN pactaris.relationship_participants rp ON rp.household_id=own.household_id AND rp.relationship_id=own.relationship_id
     JOIN pactaris.relationships rel ON rel.household_id=own.household_id AND rel.id=own.relationship_id AND rel.status='active'
     JOIN pactaris.memberships other ON other.household_id=rp.household_id AND other.id=rp.membership_id AND other.status='active'
     WHERE own.household_id=target AND own.membership_id=m.id AND own.decision='accepted' AND rp.decision='accepted' AND other.id<>m.id ORDER BY other.display_name,other.id LIMIT 100) v));
 END IF;
 IF action='noticeList' AND payload ? 'after' AND NOT EXISTS(SELECT 1 FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND id=(payload->>'after')::uuid) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',a.display_name,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND (NOT(payload ? 'after') OR push_seq<(SELECT push_seq FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND id=(payload->>'after')::uuid)) ORDER BY push_seq DESC LIMIT 31) n
  LEFT JOIN pactaris.memberships a ON a.household_id=n.household_id AND a.id=n.actor_id;
 IF jsonb_array_length(items)=31 THEN next_id=(items->29->>'id')::uuid;items=items-30;END IF;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread,'nextCursor',next_id);
END $$;

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
 SELECT max(n.push_seq) INTO notice_seq FROM pactaris.member_notices n WHERE n.household_id=target AND n.recipient_id=m.id AND NOT n.read
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

CREATE OR REPLACE FUNCTION pactaris.authority_export_page(instance uuid,account uuid,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; rows jsonb; last text;
BEGIN
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
  SELECT k,row FROM (
   SELECT p.household_id::text||':'||p.member_id::text||':noticePreferences' AS k,jsonb_build_object('kind','noticePreferences')||to_jsonb(p) AS row FROM pactaris.notice_preferences p WHERE p.member_id=ANY(members)
   UNION ALL
   SELECT x.household_id::text||':'||x.id::text AS k,jsonb_build_object('kind','link')||to_jsonb(x) AS row FROM pactaris.authority_links x WHERE x.dom_id=ANY(members) OR x.sub_id=ANY(members)
   UNION ALL
   SELECT d.household_id::text||':'||d.id::text,jsonb_build_object('kind','delegation')||to_jsonb(d) FROM pactaris.authority_delegations d
    JOIN pactaris.authority_links l ON l.household_id=d.household_id AND l.id=d.link_id WHERE d.delegate_id=ANY(members) OR l.dom_id=ANY(members) OR l.sub_id=ANY(members)
   UNION ALL
   SELECT a.household_id::text||':'||a.id::text,jsonb_build_object('kind','pointAdjustment')||to_jsonb(a) FROM pactaris.point_adjustments a WHERE a.recipient_id=ANY(members) OR a.issuer_id=ANY(members)
   UNION ALL
   SELECT b.household_id::text||':'||b.id::text,jsonb_build_object('kind','habit')||to_jsonb(b)||jsonb_build_object('entries',
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at),'[]'::jsonb) FROM pactaris.authority_habit_entries e WHERE e.household_id=b.household_id AND e.habit_id=b.id),
    'results',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.period_start),'[]'::jsonb) FROM pactaris.authority_habit_results r WHERE r.household_id=b.household_id AND r.habit_id=b.id))
    FROM pactaris.authority_habits b WHERE b.holder_id=ANY(members) OR b.subject_id=ANY(members)
   UNION ALL
   SELECT t.household_id::text||':'||t.id::text,jsonb_build_object('kind','primaryTransfer')||to_jsonb(t) FROM pactaris.authority_transfers t
    WHERE t.sub_id=ANY(members) OR t.to_dom=ANY(members) OR t.proposer_id=ANY(members) OR t.from_dom=ANY(members)
  ) all_rows WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','authority','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
