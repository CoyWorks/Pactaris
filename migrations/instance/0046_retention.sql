-- Retention and maintenance (docs/MAINTENANCE.md). Operation receipts exist so an exact retry of the
-- same request returns the first answer; after 90 days no such retry is realistic, so they and their
-- write-only outbox rows can go. Read notices go after 90 days. Membership, invitation and household
-- command receipts are kept: the gateway reconciles against them.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['approval_receipts','authority_receipts','catalog_receipts','consent_receipts','document_receipts','exchange_receipts',
  'partner_receipts','proof_receipts','relationship_receipts','routine_receipts','workspace_receipts'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON pactaris.%I(created_at)',name||'_created',name);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS member_notices_read_created ON pactaris.member_notices(created_at) WHERE read;
CREATE INDEX IF NOT EXISTS task_inbox_read_created ON pactaris.task_inbox(created_at) WHERE read;

-- One row per maintenance run on this instance; no household data.
CREATE TABLE pactaris.maintenance_runs (
 id uuid PRIMARY KEY,task text NOT NULL CHECK(task IN ('retention','proofFiles')),
 trigger text NOT NULL CHECK(trigger IN ('schedule','operator')),dry boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,ok boolean,details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX maintenance_runs_recent ON pactaris.maintenance_runs(task,started_at DESC);
ALTER TABLE pactaris.maintenance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.maintenance_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.maintenance_runs FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

-- Removes (or with dry=true only counts) what is past retention. Returns the count per item.
CREATE FUNCTION pactaris.run_retention(instance uuid,run uuid,trigger text,dry boolean,receipt_days integer,notice_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE counts jsonb:='{}'::jsonb;name text;outbox text;n bigint;cut timestamptz;
BEGIN
 IF receipt_days<30 OR notice_days<30 OR trigger NOT IN ('schedule','operator') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='maintenance.invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.maintenance.retention',0));
 INSERT INTO pactaris.maintenance_runs(id,task,trigger,dry) VALUES(run,'retention',trigger,dry);
 cut=now()-make_interval(days=>receipt_days);
 FOREACH name IN ARRAY ARRAY['approval','authority','catalog','consent','document','exchange','partner','proof','relationship','routine','workspace'] LOOP
  outbox=CASE WHEN to_regclass('pactaris.'||name||'_outbox') IS NOT NULL THEN name||'_outbox' END;
  IF dry THEN
   EXECUTE format('SELECT count(*) FROM pactaris.%I r JOIN pactaris.households h ON h.id=r.household_id WHERE h.instance_id=$1 AND r.created_at<$2',name||'_receipts') INTO n USING instance,cut;
  ELSE
   IF outbox IS NOT NULL THEN
    EXECUTE format('DELETE FROM pactaris.%I o USING pactaris.%I r,pactaris.households h WHERE o.operation_id=r.operation_id AND h.id=r.household_id AND h.instance_id=$1 AND r.created_at<$2',outbox,name||'_receipts') USING instance,cut;
   END IF;
   EXECUTE format('DELETE FROM pactaris.%I r USING pactaris.households h WHERE h.id=r.household_id AND h.instance_id=$1 AND r.created_at<$2',name||'_receipts') USING instance,cut;
   GET DIAGNOSTICS n=ROW_COUNT;
  END IF;
  counts=counts||jsonb_build_object(name||'Receipts',n);
 END LOOP;
 cut=now()-make_interval(days=>notice_days);
 IF dry THEN
  SELECT count(*) INTO n FROM pactaris.member_notices x JOIN pactaris.households h ON h.id=x.household_id WHERE h.instance_id=instance AND x.read AND x.created_at<cut;
 ELSE
  DELETE FROM pactaris.member_notices x USING pactaris.households h WHERE h.id=x.household_id AND h.instance_id=instance AND x.read AND x.created_at<cut;
  GET DIAGNOSTICS n=ROW_COUNT;
 END IF;
 counts=counts||jsonb_build_object('readNotices',n);
 IF dry THEN
  SELECT count(*) INTO n FROM pactaris.task_inbox x JOIN pactaris.households h ON h.id=x.household_id WHERE h.instance_id=instance AND x.read AND x.created_at<cut;
 ELSE
  DELETE FROM pactaris.task_inbox x USING pactaris.households h WHERE h.id=x.household_id AND h.instance_id=instance AND x.read AND x.created_at<cut;
  GET DIAGNOSTICS n=ROW_COUNT;
 END IF;
 counts=counts||jsonb_build_object('readTaskInbox',n);
 IF NOT dry THEN DELETE FROM pactaris.delegation_uses WHERE expires_at<=now(); GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object('usedTokens',n); END IF;
 -- Keep a year of run history.
 DELETE FROM pactaris.maintenance_runs WHERE started_at<now()-interval '365 days';
 UPDATE pactaris.maintenance_runs SET finished_at=now(),ok=true,details=counts WHERE id=run;
 RETURN counts;
END $$;
REVOKE ALL ON FUNCTION pactaris.run_retention(uuid,uuid,text,boolean,integer,integer) FROM PUBLIC;

-- Of the given proof IDs, which still have a file that should exist. Used to find files on disk that
-- no row explains any more (after a crash or a database restore); those files are deleted.
CREATE FUNCTION pactaris.proof_files_expected(target uuid,ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT coalesce(array_agg(id),'{}') FROM pactaris.task_proofs WHERE household_id=target AND id=ANY(ids) AND file_present
$$;
REVOKE ALL ON FUNCTION pactaris.proof_files_expected(uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION pactaris.record_maintenance(run uuid,task text,trigger text,dry boolean,ok boolean,details jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.maintenance_runs(id,task,trigger,dry,finished_at,ok,details) VALUES(run,task,trigger,dry,now(),ok,details) ON CONFLICT(id) DO NOTHING
$$;
REVOKE ALL ON FUNCTION pactaris.record_maintenance(uuid,text,text,boolean,boolean,jsonb) FROM PUBLIC;

-- Operator view: recent runs and the largest tables (names and sizes only, no content).
CREATE FUNCTION pactaris.maintenance_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT jsonb_build_object(
  'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'task',r.task,'trigger',r.trigger,'dry',r.dry,'startedAt',r.started_at,'finishedAt',r.finished_at,'ok',r.ok,'details',r.details) ORDER BY r.started_at DESC),'[]'::jsonb)
    FROM (SELECT * FROM pactaris.maintenance_runs ORDER BY started_at DESC LIMIT 20) r),
  'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.relname,'bytes',t.bytes,'rows',t.estimate) ORDER BY t.bytes DESC),'[]'::jsonb)
    FROM (SELECT c.relname,pg_total_relation_size(c.oid) AS bytes,greatest(c.reltuples,0)::bigint AS estimate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='pactaris' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15) t),
  'database',pg_database_size(current_database()),
  'proofs',(SELECT jsonb_build_object('stored',count(*) FILTER (WHERE state='stored'),'files',count(*) FILTER (WHERE file_present),'bytes',coalesce(sum(size) FILTER (WHERE file_present),0)) FROM pactaris.task_proofs))
$$;
REVOKE ALL ON FUNCTION pactaris.maintenance_status() FROM PUBLIC;
