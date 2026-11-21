-- Purging dynamics that everyone left (owner decision, 21 November 2026; docs/MAINTENANCE.md).
-- A dynamic closes when its last member leaves. 30 days later everything in it is deleted; only a
-- tombstone row (ID, instance, closed and purged times) and its content-free revocation journal stay.
ALTER TABLE pactaris.households ADD COLUMN closed_at timestamptz,ADD COLUMN purged_at timestamptz;
UPDATE pactaris.households SET closed_at=now() WHERE status='closed';
CREATE INDEX households_closed ON pactaris.households(instance_id,closed_at) WHERE status='closed' AND purged_at IS NULL;
CREATE FUNCTION pactaris.household_closed_at() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF NEW.status='closed' AND OLD.status IS DISTINCT FROM 'closed' THEN NEW.closed_at=now(); END IF;
 IF NEW.status<>'closed' THEN NEW.closed_at=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER household_closed_at BEFORE UPDATE OF status ON pactaris.households FOR EACH ROW EXECUTE FUNCTION pactaris.household_closed_at();
ALTER TABLE pactaris.maintenance_runs DROP CONSTRAINT maintenance_runs_task_check;
ALTER TABLE pactaris.maintenance_runs ADD CONSTRAINT maintenance_runs_task_check CHECK(task IN ('retention','proofFiles','householdPurge'));

-- Deletes every row of one closed household in every table that has a household_id, retrying in
-- passes so foreign keys between those tables resolve in any order. New tables are covered without
-- changing this function; the integration test checks that nothing is left behind.
CREATE FUNCTION pactaris.purge_household(target uuid,grace_days integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE t record;n bigint;total bigint:=0;blocked boolean;pass integer:=0;
BEGIN
 IF grace_days<30 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='maintenance.invalid'; END IF;
 PERFORM 1 FROM pactaris.households WHERE id=target AND status='closed' AND purged_at IS NULL AND closed_at<now()-make_interval(days=>grace_days)
  AND NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND status='active') FOR UPDATE;
 IF NOT FOUND THEN RETURN -1; END IF;
 LOOP
  pass=pass+1;blocked=false;
  FOR t IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema=c.table_schema AND x.table_name=c.table_name
   WHERE c.table_schema='pactaris' AND c.column_name='household_id' AND x.table_type='BASE TABLE' AND c.table_name NOT IN ('households','revocation_journal') ORDER BY c.table_name LOOP
   BEGIN
    EXECUTE format('DELETE FROM pactaris.%I WHERE household_id=$1',t.table_name) USING target;
    GET DIAGNOSTICS n=ROW_COUNT;total=total+n;
   EXCEPTION WHEN foreign_key_violation THEN blocked=true;
   END;
  END LOOP;
  EXIT WHEN NOT blocked;
  IF pass>=25 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='maintenance.purge_blocked'; END IF;
 END LOOP;
 UPDATE pactaris.households SET display_name='-',points_label=NULL,purged_at=now() WHERE id=target;
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION pactaris.purge_household(uuid,integer) FROM PUBLIC;

-- Dynamics without active members that are not closed yet (for example after account erasure) are
-- closed first; their grace period starts then. Returns what is due or, with dry=true, would be.
CREATE FUNCTION pactaris.purge_candidates(instance uuid,grace_days integer,dry boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE closed bigint:=0;
BEGIN
 IF dry THEN
  SELECT count(*) INTO closed FROM pactaris.households h WHERE h.instance_id=instance AND h.status<>'closed'
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m WHERE m.household_id=h.id AND m.status='active');
 ELSE
  UPDATE pactaris.households h SET status='closed' WHERE h.instance_id=instance AND h.status<>'closed'
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m WHERE m.household_id=h.id AND m.status='active');
  GET DIAGNOSTICS closed=ROW_COUNT;
 END IF;
 RETURN jsonb_build_object('closedEmpty',closed,'due',(SELECT coalesce(jsonb_agg(id ORDER BY closed_at),'[]'::jsonb) FROM (SELECT id,closed_at FROM pactaris.households
  WHERE instance_id=instance AND status='closed' AND purged_at IS NULL AND closed_at<now()-make_interval(days=>grace_days) ORDER BY closed_at LIMIT 50) d));
END $$;
REVOKE ALL ON FUNCTION pactaris.purge_candidates(uuid,integer,boolean) FROM PUBLIC;

-- Operator view: closed dynamics waiting for their purge, recently purged ones (for the gateway to
-- retire their placements) and the number of dynamics that have members but no owner.
CREATE FUNCTION pactaris.household_lifecycle(instance uuid,grace_days integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT jsonb_build_object(
  'waiting',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'closedAt',closed_at,'purgeAfter',closed_at+make_interval(days=>grace_days)) ORDER BY closed_at),'[]'::jsonb)
   FROM (SELECT id,closed_at FROM pactaris.households WHERE instance_id=instance AND status='closed' AND purged_at IS NULL ORDER BY closed_at LIMIT 50) w),
  'purged',(SELECT coalesce(jsonb_agg(id ORDER BY purged_at DESC),'[]'::jsonb) FROM (SELECT id,purged_at FROM pactaris.households
   WHERE instance_id=instance AND purged_at>now()-interval '90 days' ORDER BY purged_at DESC LIMIT 200) p),
  'ownerless',(SELECT count(*) FROM pactaris.households h WHERE h.instance_id=instance AND h.status<>'closed'
   AND EXISTS(SELECT 1 FROM pactaris.memberships m WHERE m.household_id=h.id AND m.status='active')
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m WHERE m.household_id=h.id AND m.status='active' AND m.technical_role='owner')))
$$;
REVOKE ALL ON FUNCTION pactaris.household_lifecycle(uuid,integer) FROM PUBLIC;
