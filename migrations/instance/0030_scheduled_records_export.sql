CREATE FUNCTION pactaris.cancel_departed_redemptions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.reward_redemptions SET state='cancelled',version=version+1 WHERE household_id=NEW.household_id
   AND NEW.id IN (issuer_id,recipient_id) AND state IN ('offered','requested');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.cancel_departed_redemptions() FROM PUBLIC;
CREATE TRIGGER reward_redemption_departure AFTER UPDATE OF status ON pactaris.memberships
 FOR EACH ROW EXECUTE FUNCTION pactaris.cancel_departed_redemptions();

CREATE OR REPLACE FUNCTION pactaris.personal_export(target uuid,instance uuid,actor uuid,member uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE tasks jsonb; documents jsonb; schedules jsonb; redemptions jsonb; delivery jsonb; truncated boolean;
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE m.household_id=target AND m.id=member AND m.account_id=actor AND m.status='active'
   AND h.instance_id=instance AND h.status IN ('active','paused')
 ) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) INTO tasks FROM (
  SELECT id,title,description,priority,due_at,state,created_at,updated_at,personal_series_id,personal_series_version,personal_occurrence_date
  FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=member ORDER BY id LIMIT 6
 ) t;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) INTO documents FROM (
  SELECT d.id,d.kind,d.state,v.title,v.body,v.category,d.created_at,d.updated_at
  FROM pactaris.documents d INNER JOIN pactaris.document_versions v
  ON v.household_id=d.household_id AND v.document_id=d.id AND v.version=d.version
  WHERE d.household_id=target AND d.creator_membership_id=member AND d.state<>'deleted' ORDER BY d.id LIMIT 3
 ) d;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id,s.version),'[]'::jsonb) INTO schedules FROM (
  SELECT id,version,state,fields,schedule FROM pactaris.personal_task_series WHERE household_id=target AND creator_id=member
  ORDER BY id,version LIMIT 6
 ) s;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO redemptions FROM (
  SELECT id,version,state,terms,points,expires_at,CASE WHEN issuer_id=member THEN 'issuer' ELSE 'recipient' END AS role,
   (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'createdAt',e.created_at) ORDER BY e.created_at),'[]')
    FROM pactaris.reward_point_entries e WHERE e.household_id=target AND e.redemption_id=v.id) AS ledger
  FROM pactaris.reward_redemptions v WHERE household_id=target AND member IN (issuer_id,recipient_id)
  ORDER BY id LIMIT 6
 ) r;
 SELECT jsonb_build_object('push',p.push_enabled,'reminders',p.reminders,'quietStart',p.quiet_start,
  'quietEnd',p.quiet_end,'timeZone',p.time_zone) INTO delivery
  FROM pactaris.task_delivery_preferences p WHERE p.household_id=target AND p.member_id=member;
 truncated=jsonb_array_length(tasks)>5 OR jsonb_array_length(documents)>2 OR jsonb_array_length(schedules)>5 OR jsonb_array_length(redemptions)>5;
 RETURN jsonb_build_object('householdId',target,'tasks',tasks-5,'documents',documents-2,'schedules',schedules-5,
  'redemptions',redemptions-5,'taskDelivery',delivery,'truncated',truncated);
END $$;
REVOKE ALL ON FUNCTION pactaris.personal_export(uuid,uuid,uuid,uuid) FROM PUBLIC;
