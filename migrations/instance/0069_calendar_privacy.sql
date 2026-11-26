-- ICS subscriptions (owner decision, 26 November 2026; docs/CALENDAR_FEED.md): an item's title can be
-- hidden from calendar subscriptions. The choice belongs to the item, so a repeating task's choice also
-- covers its occurrences. The creator or the person it is for can change it; the app shows titles as usual.
CREATE TABLE pactaris.calendar_hidden (
 household_id uuid NOT NULL REFERENCES pactaris.households(id),resource_id uuid NOT NULL,set_by uuid NOT NULL,
 set_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(household_id,resource_id),
 FOREIGN KEY(household_id,set_by) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.calendar_hidden ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.calendar_hidden FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.calendar_hidden FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE FUNCTION pactaris.calendar_is_hidden(target uuid,a uuid,b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pactaris.calendar_hidden WHERE household_id=target AND resource_id IN (a,b))
$$;
REVOKE ALL ON FUNCTION pactaris.calendar_is_hidden(uuid,uuid,uuid) FROM PUBLIC;

-- Sets or clears the choice for one item the actor created or that is for them.
CREATE FUNCTION pactaris.calendar_mark(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;resource uuid;kind text;allowed boolean;
BEGIN
 PERFORM 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 resource=(body->>'resourceId')::uuid;kind=body->>'kind';
 IF jsonb_typeof(body->'hidden') IS DISTINCT FROM 'boolean' OR resource IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 allowed=CASE kind
  WHEN 'task' THEN EXISTS(SELECT 1 FROM pactaris.tasks WHERE household_id=target AND id=resource AND creator_membership_id=m.id)
  WHEN 'taskSeries' THEN EXISTS(SELECT 1 FROM pactaris.personal_task_series WHERE household_id=target AND id=resource AND creator_id=m.id)
  WHEN 'partnerTask' THEN EXISTS(SELECT 1 FROM pactaris.partner_tasks WHERE household_id=target AND id=resource AND m.id IN (creator_id,assignee_id))
  WHEN 'partnerSeries' THEN EXISTS(SELECT 1 FROM pactaris.task_series WHERE household_id=target AND id=resource AND m.id IN (creator_id,assignee_id))
  WHEN 'habit' THEN EXISTS(SELECT 1 FROM pactaris.authority_habits WHERE household_id=target AND id=resource AND m.id IN (holder_id,subject_id))
  WHEN 'routine' THEN EXISTS(SELECT 1 FROM pactaris.routines WHERE household_id=target AND id=resource AND creator_membership_id=m.id)
  ELSE NULL END;
 IF allowed IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 IF NOT allowed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF (body->>'hidden')::boolean THEN
  INSERT INTO pactaris.calendar_hidden(household_id,resource_id,set_by) VALUES(target,resource,m.id) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM pactaris.calendar_hidden WHERE household_id=target AND resource_id=resource;
 END IF;
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied','resourceId',resource);
END $$;
REVOKE ALL ON FUNCTION pactaris.calendar_mark(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pactaris.planner_read(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;person uuid;first date;last date;zone text;today date;self boolean;
 items jsonb;people jsonb;
BEGIN
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 zone=coalesce(body->>'timeZone',h.time_zone);
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) OR body->>'from' IS NULL
  OR coalesce((body->>'days')::int,0) NOT BETWEEN 1 AND 42 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 first=(body->>'from')::date;last=first+(body->>'days')::int-1;today=(now() AT TIME ZONE zone)::date;
 person=coalesce((body->>'personId')::uuid,m.id);self=person=m.id;
 IF NOT self AND NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=person AND status='active')
  THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF NOT self AND NOT pactaris.authority_area(target,m.id,person,'tasks') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;

 WITH days AS (SELECT d::date AS day FROM generate_series(first::timestamp,last::timestamp,interval '1 day') d),
 weeks AS (SELECT greatest(w::date,first) AS day,w::date AS week FROM generate_series(date_trunc('week',first::timestamp),last::timestamp,interval '7 days') w),
 rows AS (
  -- Private tasks with a due time (creator only).
  SELECT 'task' AS kind,t.id AS id,(t.due_at AT TIME ZONE zone)::date AS day,t.due_at AS at,t.title AS title,t.state AS state,
   (t.state='open' AND t.due_at<now()) AS overdue,false AS projected,false AS on_break,pactaris.calendar_is_hidden(target,t.id,t.personal_series_id) AS hidden
   FROM pactaris.tasks t WHERE self AND t.household_id=target AND t.creator_membership_id=m.id AND t.due_at IS NOT NULL AND t.state<>'archived'
   AND (t.due_at AT TIME ZONE zone)::date BETWEEN first AND last
  UNION ALL
  -- Future occurrences of private repeating tasks that the worker has not created yet.
  SELECT 'taskSeries',s.id,d.day,pactaris.task_occurrence_at(s.schedule,d.day),s.fields->>'title','planned',false,true,false,pactaris.calendar_is_hidden(target,s.id,NULL::uuid)
   FROM pactaris.personal_task_series s JOIN days d ON d.day>=today
   WHERE self AND s.household_id=target AND s.creator_id=m.id AND s.state='active'
   AND pactaris.task_occurrence_at(s.schedule,d.day) IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM pactaris.tasks x WHERE x.household_id=target AND x.personal_series_id=s.id AND x.personal_occurrence_date=d.day)
  UNION ALL
  -- Dom/sub tasks assigned to this person: due time, else the time it becomes available.
  SELECT 'partnerTask',t.id,(coalesce((t.fields->>'dueAt')::timestamptz,t.available_at) AT TIME ZONE zone)::date,
   coalesce((t.fields->>'dueAt')::timestamptz,t.available_at),t.fields->>'title',t.state,
   (t.state IN ('assigned','offered','accepted','in_progress','changes_requested') AND (t.fields->>'dueAt')::timestamptz<now()),false,false,pactaris.calendar_is_hidden(target,t.id,t.series_id)
   FROM pactaris.partner_tasks t WHERE t.household_id=target AND t.assignee_id=person AND t.state NOT IN ('declined','cancelled')
   AND coalesce((t.fields->>'dueAt')::timestamptz,t.available_at) IS NOT NULL
   AND (coalesce((t.fields->>'dueAt')::timestamptz,t.available_at) AT TIME ZONE zone)::date BETWEEN first AND last
  UNION ALL
  -- Future occurrences of Dom/sub task series that the worker has not created yet.
  SELECT 'partnerSeries',s.id,d.day,pactaris.task_occurrence_at(s.schedule,d.day),s.fields->>'title','planned',false,true,false,pactaris.calendar_is_hidden(target,s.id,NULL::uuid)
   FROM pactaris.task_series s JOIN days d ON d.day>=today
   WHERE s.household_id=target AND s.assignee_id=person AND s.state='active'
   AND pactaris.task_occurrence_at(s.schedule,d.day) IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM pactaris.partner_tasks x WHERE x.household_id=target AND x.series_id=s.id AND x.occurrence_date=d.day)
  UNION ALL
  -- Daily habits a Dom set, on their weekdays; a planned break shows as such. Past days carry their result.
  SELECT 'habit',a.id,d.day,NULL::timestamptz,a.title,coalesce(r.result,'planned'),false,d.day>=today,
   pactaris.habit_break_overlap(a.breaks,d.day,d.day),pactaris.calendar_is_hidden(target,a.id,NULL::uuid)
   FROM pactaris.authority_habits a JOIN days d ON d.day>=(a.created_at AT TIME ZONE zone)::date
   LEFT JOIN pactaris.authority_habit_results r ON r.household_id=a.household_id AND r.habit_id=a.id AND r.period_start=d.day
   WHERE a.household_id=target AND a.subject_id=person AND a.state='active' AND a.period='daily'
   AND extract(isodow FROM d.day)::smallint=ANY(a.weekdays)
  UNION ALL
  -- Weekly habits a Dom set: once per week, on its first day in the range.
  SELECT 'habit',a.id,w.day,NULL::timestamptz,a.title,coalesce(r.result,'planned'),false,w.week>=date_trunc('week',today)::date,
   pactaris.habit_break_overlap(a.breaks,w.week,w.week+6),pactaris.calendar_is_hidden(target,a.id,NULL::uuid)
   FROM pactaris.authority_habits a JOIN weeks w ON w.week+6>=(a.created_at AT TIME ZONE zone)::date
   LEFT JOIN pactaris.authority_habit_results r ON r.household_id=a.household_id AND r.habit_id=a.id AND r.period_start=w.week
   WHERE a.household_id=target AND a.subject_id=person AND a.state='active' AND a.period='weekly'
  UNION ALL
  -- The viewer's own habits, rituals and check-ins (Routines), from their current revision.
  SELECT CASE r.kind WHEN 'habit' THEN 'routineHabit' WHEN 'ritual' THEN 'ritual' ELSE 'checkin' END,r.id,d.day,NULL::timestamptz,v.fields->>'title','planned',false,true,false,pactaris.calendar_is_hidden(target,r.id,NULL::uuid)
   FROM pactaris.routines r JOIN pactaris.routine_revisions v ON v.household_id=r.household_id AND v.routine_id=r.id AND v.revision=r.revision
   JOIN days d ON true
   WHERE self AND r.household_id=target AND r.creator_membership_id=m.id AND r.state='active'
   AND ((v.fields->>'period'='daily' AND (NOT v.fields ? 'weekdays' OR v.fields->'weekdays' @> to_jsonb(extract(isodow FROM d.day)::int)))
    OR (v.fields->>'period'='once' AND (v.fields->>'date')::date=d.day)
    OR (v.fields->>'period'='weekly' AND (d.day=first OR extract(isodow FROM d.day)=1)))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.id,'day',to_char(x.day,'YYYY-MM-DD'),'at',x.at,'title',x.title,'state',x.state,
   'overdue',x.overdue,'projected',x.projected,'onBreak',x.on_break,'hidden',x.hidden) ORDER BY x.day,x.at NULLS FIRST,x.title,x.id),'[]'::jsonb) INTO items
  FROM (SELECT * FROM rows WHERE title IS NOT NULL ORDER BY day,at NULLS FIRST,title,id LIMIT 600) x;

 SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.display_name,'self',o.id=m.id) ORDER BY o.id<>m.id,o.display_name,o.id),'[]'::jsonb) INTO people
  FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active'
  AND (o.id=m.id OR pactaris.authority_area(target,m.id,o.id,'tasks'));

 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','listed',
  'planner',jsonb_build_object('from',to_char(first,'YYYY-MM-DD'),'days',(body->>'days')::int,'timeZone',zone,'personId',person,'people',people,'items',items));
END $$;
REVOKE ALL ON FUNCTION pactaris.planner_read(uuid,uuid,uuid,jsonb) FROM PUBLIC;
