-- Plan horizon (docs/HOUSEHOLD_PLANS.md, owner decisions 26-28 November 2026): how far ahead a date may be
-- planned (`plan.horizon.days`, Free 14). Checked only when a date is set or moved: a new task's due date,
-- a series' start date and a one-time routine's date. Dates set earlier stay as they are after a downgrade,
-- and saving an item without moving its date is never refused. Generated occurrences are not checked.

-- The last allowed moment: now plus the horizon (timestamps), or the dynamic's local today plus the
-- horizon (calendar dates).
CREATE FUNCTION pactaris.plan_horizon_until(target uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT now()+make_interval(days=>pactaris.plan_limit(target,'plan.horizon.days'))
$$;
CREATE FUNCTION pactaris.plan_horizon_date(target uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT (now() AT TIME ZONE coalesce((SELECT time_zone FROM pactaris.households WHERE id=target),'UTC'))::date
  +pactaris.plan_limit(target,'plan.horizon.days')
$$;
REVOKE ALL ON FUNCTION pactaris.plan_horizon_until(uuid),pactaris.plan_horizon_date(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.plan_horizon_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE due timestamptz;previous_due timestamptz;day date;previous_day date;
BEGIN
 IF current_setting('pactaris.series_generation',true)='on' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='tasks' THEN
  IF NEW.personal_series_id IS NOT NULL THEN RETURN NEW;END IF;
  due=NEW.due_at;IF TG_OP='UPDATE' THEN previous_due=OLD.due_at;END IF;
 ELSIF TG_TABLE_NAME='partner_tasks' THEN
  IF NEW.series_id IS NOT NULL THEN RETURN NEW;END IF;
  due=(NEW.fields->>'dueAt')::timestamptz;IF TG_OP='UPDATE' THEN previous_due=(OLD.fields->>'dueAt')::timestamptz;END IF;
 ELSIF TG_TABLE_NAME='task_series' THEN
  day=(NEW.schedule->>'startDate')::date;IF TG_OP='UPDATE' THEN previous_day=(OLD.schedule->>'startDate')::date;END IF;
 ELSIF TG_TABLE_NAME='personal_task_series' THEN
  -- A revision is a new row; compare with the version it supersedes.
  day=(NEW.schedule->>'startDate')::date;
  SELECT (schedule->>'startDate')::date INTO previous_day FROM pactaris.personal_task_series
   WHERE household_id=NEW.household_id AND id=NEW.id AND version=NEW.version-1;
 ELSE
  -- routine_revisions: a one-time routine's date, compared with the previous revision.
  day=(NEW.fields->>'date')::date;
  SELECT (fields->>'date')::date INTO previous_day FROM pactaris.routine_revisions
   WHERE household_id=NEW.household_id AND routine_id=NEW.routine_id AND revision=NEW.revision-1;
 END IF;
 IF due IS NOT NULL AND due IS DISTINCT FROM previous_due AND due>pactaris.plan_horizon_until(NEW.household_id) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.horizon';
 END IF;
 IF day IS NOT NULL AND day IS DISTINCT FROM previous_day AND day>pactaris.plan_horizon_date(NEW.household_id) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.horizon';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_horizon_check() FROM PUBLIC;
CREATE TRIGGER plan_horizon_task BEFORE INSERT OR UPDATE OF due_at ON pactaris.tasks FOR EACH ROW EXECUTE FUNCTION pactaris.plan_horizon_check();
CREATE TRIGGER plan_horizon_partner BEFORE INSERT OR UPDATE OF fields ON pactaris.partner_tasks FOR EACH ROW EXECUTE FUNCTION pactaris.plan_horizon_check();
CREATE TRIGGER plan_horizon_series BEFORE INSERT OR UPDATE OF schedule ON pactaris.task_series FOR EACH ROW EXECUTE FUNCTION pactaris.plan_horizon_check();
CREATE TRIGGER plan_horizon_personal_series BEFORE INSERT ON pactaris.personal_task_series FOR EACH ROW EXECUTE FUNCTION pactaris.plan_horizon_check();
CREATE TRIGGER plan_horizon_routine BEFORE INSERT ON pactaris.routine_revisions FOR EACH ROW EXECUTE FUNCTION pactaris.plan_horizon_check();
