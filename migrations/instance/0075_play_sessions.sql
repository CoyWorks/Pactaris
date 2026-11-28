-- Play sessions (owner decisions, 28 November 2026; docs/PLAY_SESSIONS.md): a note-style entry in a person's own
-- calendar, about a session that may include people outside the app or outside the dynamic (free names).
-- A session is private to the person who writes it. Linking a member of the dynamic is optional and per
-- person: they may view the session, and may also write their own part. Sessions count towards no plan
-- limit and the plan horizon does not apply. Nothing here is shown to administrators.
CREATE TABLE pactaris.play_sessions (
 household_id uuid NOT NULL REFERENCES pactaris.households(id),id uuid NOT NULL,owner_id uuid NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),starts_at timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 1440),
 location text NOT NULL DEFAULT '' CHECK(char_length(location)<=200),with_whom text NOT NULL DEFAULT '' CHECK(char_length(with_whom)<=300),
 preparation text NOT NULL DEFAULT '' CHECK(octet_length(preparation)<=3500),aftercare text NOT NULL DEFAULT '' CHECK(octet_length(aftercare)<=3500),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,id),FOREIGN KEY(household_id,owner_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX ON pactaris.play_sessions(household_id,owner_id,starts_at);
-- A linked member: permission to view, optionally to write their own part (which implies viewing).
CREATE TABLE pactaris.play_session_members (
 household_id uuid NOT NULL,session_id uuid NOT NULL,membership_id uuid NOT NULL,
 can_edit boolean NOT NULL DEFAULT false,
 preparation text NOT NULL DEFAULT '' CHECK(octet_length(preparation)<=3500),aftercare text NOT NULL DEFAULT '' CHECK(octet_length(aftercare)<=3500),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,session_id,membership_id),
 FOREIGN KEY(household_id,session_id) REFERENCES pactaris.play_sessions(household_id,id) ON DELETE CASCADE,
 FOREIGN KEY(household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX ON pactaris.play_session_members(household_id,membership_id);
ALTER TABLE pactaris.play_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.play_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.play_sessions FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
ALTER TABLE pactaris.play_session_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.play_session_members FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.play_session_members FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

-- 'owner', 'edit' (linked, may write their own part), 'view' (linked, may view) or 'none'. A member who
-- left the dynamic has no access; an owner who left keeps nothing visible to others either.
CREATE FUNCTION pactaris.play_session_access(target uuid,session uuid,member uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT CASE WHEN p.owner_id=member THEN 'owner'
  WHEN l.membership_id IS NOT NULL AND EXISTS(SELECT 1 FROM pactaris.memberships o WHERE o.household_id=target AND o.id=p.owner_id AND o.status='active')
   THEN CASE WHEN l.can_edit THEN 'edit' ELSE 'view' END
  ELSE 'none' END
 FROM pactaris.play_sessions p LEFT JOIN pactaris.play_session_members l ON l.household_id=p.household_id AND l.session_id=p.id AND l.membership_id=member
 WHERE p.household_id=target AND p.id=session
$$;
REVOKE ALL ON FUNCTION pactaris.play_session_access(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.play_session_member(target uuid,instance uuid,actor uuid,body jsonb) RETURNS pactaris.memberships
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 RETURN m;
END $$;
REVOKE ALL ON FUNCTION pactaris.play_session_member(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- One session, for its owner or a linked member who may view it.
CREATE FUNCTION pactaris.play_session_read(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;p pactaris.play_sessions;access text;members jsonb;
BEGIN
 m=pactaris.play_session_member(target,instance,actor,body);
 SELECT * INTO p FROM pactaris.play_sessions WHERE household_id=target AND id=(body->>'sessionId')::uuid;
 access=CASE WHEN p.id IS NULL THEN 'none' ELSE pactaris.play_session_access(target,p.id,m.id) END;
 IF access='none' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',l.membership_id,'name',o.display_name,'canEdit',l.can_edit,
   'preparation',l.preparation,'aftercare',l.aftercare) ORDER BY o.display_name,l.membership_id),'[]'::jsonb) INTO members
  FROM pactaris.play_session_members l JOIN pactaris.memberships o ON o.household_id=l.household_id AND o.id=l.membership_id AND o.status='active'
  WHERE l.household_id=target AND l.session_id=p.id;
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','listed',
  'session',jsonb_build_object('sessionId',p.id,'version',p.version::text,'access',access,
   'ownerName',(SELECT display_name FROM pactaris.memberships WHERE household_id=target AND id=p.owner_id),
   'title',p.title,'startsAt',to_char(p.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'durationMinutes',p.duration_minutes,
   'location',p.location,'withWhom',p.with_whom,'preparation',p.preparation,'aftercare',p.aftercare,'members',members,
   'hidden',pactaris.calendar_is_hidden(target,p.id,NULL::uuid)));
END $$;
REVOKE ALL ON FUNCTION pactaris.play_session_read(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- Create (sessionId null: the operation ID becomes the session ID, so a retry is harmless) or update the
-- basics and the linked members. Owner only. Notes are saved with play_session_note.
CREATE FUNCTION pactaris.play_session_save(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;p pactaris.play_sessions;f jsonb;sid uuid;x jsonb;linked uuid[]:='{}';
BEGIN
 m=pactaris.play_session_member(target,instance,actor,body);
 f=body->'fields';
 IF f IS NULL OR jsonb_typeof(body->'members')<>'array' OR jsonb_array_length(body->'members')>20 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 IF body->>'sessionId' IS NULL THEN
  sid=(body->>'operationId')::uuid;
  SELECT * INTO p FROM pactaris.play_sessions WHERE household_id=target AND play_sessions.id=sid;
  IF FOUND THEN
   IF p.owner_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
   RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied','sessionId',sid);
  END IF;
  INSERT INTO pactaris.play_sessions(household_id,id,owner_id,title,starts_at,duration_minutes,location,with_whom)
   VALUES(target,sid,m.id,f->>'title',(f->>'startsAt')::timestamptz,(f->>'durationMinutes')::integer,f->>'location',f->>'withWhom');
 ELSE
  SELECT * INTO p FROM pactaris.play_sessions WHERE household_id=target AND play_sessions.id=(body->>'sessionId')::uuid FOR UPDATE;
  IF NOT FOUND OR p.owner_id<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF p.version::text IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  sid=p.id;
  UPDATE pactaris.play_sessions SET title=f->>'title',starts_at=(f->>'startsAt')::timestamptz,duration_minutes=(f->>'durationMinutes')::integer,
   location=f->>'location',with_whom=f->>'withWhom',version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND play_sessions.id=sid;
 END IF;
 -- Linked members: active members of this dynamic other than the owner. Removing a link removes their part.
 FOR x IN SELECT * FROM jsonb_array_elements(body->'members') LOOP
  IF (x->>'membershipId')::uuid=m.id OR NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND memberships.id=(x->>'membershipId')::uuid AND status='active') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
  linked=linked||(x->>'membershipId')::uuid;
  INSERT INTO pactaris.play_session_members(household_id,session_id,membership_id,can_edit) VALUES(target,sid,(x->>'membershipId')::uuid,(x->>'canEdit')::boolean)
   ON CONFLICT(household_id,session_id,membership_id) DO UPDATE SET can_edit=EXCLUDED.can_edit;
 END LOOP;
 DELETE FROM pactaris.play_session_members WHERE household_id=target AND session_id=sid AND NOT (membership_id=ANY(linked));
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.sessionSave',sid,jsonb_build_object('operationId',body->>'operationId'));
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied','sessionId',sid);
END $$;
REVOKE ALL ON FUNCTION pactaris.play_session_save(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- One note: the owner's own preparation or aftercare, or a linked member's own part (if they may edit).
CREATE FUNCTION pactaris.play_session_note(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;access text;section text;note text;
BEGIN
 m=pactaris.play_session_member(target,instance,actor,body);
 section=body->>'section';note=body->>'text';
 IF section NOT IN ('preparation','aftercare') OR note IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 access=coalesce(pactaris.play_session_access(target,(body->>'sessionId')::uuid,m.id),'none');
 IF access='owner' THEN
  UPDATE pactaris.play_sessions SET preparation=CASE WHEN section='preparation' THEN note ELSE preparation END,
   aftercare=CASE WHEN section='aftercare' THEN note ELSE aftercare END,updated_at=statement_timestamp()
   WHERE household_id=target AND id=(body->>'sessionId')::uuid;
 ELSIF access='edit' THEN
  UPDATE pactaris.play_session_members SET preparation=CASE WHEN section='preparation' THEN note ELSE preparation END,
   aftercare=CASE WHEN section='aftercare' THEN note ELSE aftercare END,updated_at=statement_timestamp()
   WHERE household_id=target AND session_id=(body->>'sessionId')::uuid AND membership_id=m.id;
 ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied';
 END IF;
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied','sessionId',body->>'sessionId');
END $$;
REVOKE ALL ON FUNCTION pactaris.play_session_note(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- The owner deletes a session, with every linked part. A session is a personal note, not a record.
CREATE FUNCTION pactaris.play_session_delete(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;
BEGIN
 m=pactaris.play_session_member(target,instance,actor,body);
 DELETE FROM pactaris.play_sessions WHERE household_id=target AND id=(body->>'sessionId')::uuid AND owner_id=m.id;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 DELETE FROM pactaris.calendar_hidden WHERE household_id=target AND resource_id=(body->>'sessionId')::uuid;
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.sessionDelete',(body->>'sessionId')::uuid,jsonb_build_object('operationId',body->>'operationId'));
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied','sessionId',body->>'sessionId');
END $$;
REVOKE ALL ON FUNCTION pactaris.play_session_delete(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- The calendar (planner, ICS), title hiding and moving include sessions.
CREATE OR REPLACE FUNCTION pactaris.calendar_mark(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
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
  WHEN 'session' THEN pactaris.play_session_access(target,resource,m.id) IN ('owner','view','edit')
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
  UNION ALL
  -- Play sessions in the viewer's own calendar: their own, and those they are linked to and may view.
  SELECT 'session',p.id,(p.starts_at AT TIME ZONE zone)::date,p.starts_at,p.title,CASE WHEN p.owner_id=m.id THEN 'planned' ELSE 'shared' END,false,false,false,pactaris.calendar_is_hidden(target,p.id,NULL::uuid)
   FROM pactaris.play_sessions p
   WHERE self AND p.household_id=target AND pactaris.play_session_access(target,p.id,m.id) IN ('owner','view','edit')
   AND (p.starts_at AT TIME ZONE zone)::date BETWEEN first AND last
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.id,'day',to_char(x.day,'YYYY-MM-DD'),'at',x.at,'title',x.title,'state',x.state,
   'overdue',x.overdue,'projected',x.projected,'onBreak',x.on_break,'hidden',x.hidden,
   'minutes',CASE WHEN x.kind='session' THEN (SELECT s.duration_minutes FROM pactaris.play_sessions s WHERE s.household_id=target AND s.id=x.id) END) ORDER BY x.day,x.at NULLS FIRST,x.title,x.id),'[]'::jsonb) INTO items
  FROM (SELECT * FROM rows WHERE title IS NOT NULL ORDER BY day,at NULLS FIRST,title,id LIMIT 600) x;

 SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.display_name,'self',o.id=m.id) ORDER BY o.id<>m.id,o.display_name,o.id),'[]'::jsonb) INTO people
  FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active'
  AND (o.id=m.id OR pactaris.authority_area(target,m.id,o.id,'tasks'));

 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','listed',
  'planner',jsonb_build_object('from',to_char(first,'YYYY-MM-DD'),'days',(body->>'days')::int,'timeZone',zone,'personId',person,'people',people,'items',items));
END $$;
REVOKE ALL ON FUNCTION pactaris.planner_read(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pactaris.planner_move(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;s pactaris.play_sessions;zone text;day date;t pactaris.tasks;p pactaris.partner_tasks;due timestamptz;moved timestamptz;
BEGIN
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 -- Moving is a change: a paused dynamic or a personal pause stops it, as for any edit.
 IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.paused'; END IF;
 zone=body->>'timeZone';
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) OR body->>'day' IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 day=(body->>'day')::date;
 IF day<(now() AT TIME ZONE zone)::date THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 IF body->>'kind'='task' THEN
  SELECT * INTO t FROM pactaris.tasks WHERE household_id=target AND id=(body->>'itemId')::uuid AND creator_membership_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF t.state<>'open' OR t.personal_series_id IS NOT NULL OR t.due_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  due=t.due_at;
  moved=(day+(due AT TIME ZONE zone)::time) AT TIME ZONE zone;
  IF moved<>due THEN
   UPDATE pactaris.tasks SET due_at=moved,version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=t.id;
  END IF;
 ELSIF body->>'kind'='partnerTask' THEN
  SELECT * INTO p FROM pactaris.partner_tasks WHERE household_id=target AND id=(body->>'itemId')::uuid AND creator_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  IF p.state IN ('done','declined','cancelled') OR p.series_id IS NOT NULL OR p.fields->>'dueAt' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
  due=(p.fields->>'dueAt')::timestamptz;
  moved=(day+(due AT TIME ZONE zone)::time) AT TIME ZONE zone;
  IF moved<>due THEN
   UPDATE pactaris.partner_tasks SET fields=jsonb_set(fields,'{dueAt}',to_jsonb(to_char(moved AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),version=version+1
    WHERE household_id=target AND id=p.id;
   INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,p.id,p.version+1,'partnerMove',m.id,'');
   -- A reminder that was already sent for the old date is due again for the new one.
   UPDATE pactaris.task_reminder_jobs SET finished=false,due_at=moved,run_after=greatest(moved-interval '1 hour',now())
    WHERE household_id=target AND task_id=p.id AND moved>now();
  END IF;
 ELSIF body->>'kind'='session' THEN
  -- Only the person who wrote the session moves it; the plan horizon does not apply to sessions.
  SELECT * INTO s FROM pactaris.play_sessions WHERE household_id=target AND id=(body->>'itemId')::uuid AND owner_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
  moved=(day+(s.starts_at AT TIME ZONE zone)::time) AT TIME ZONE zone;
  IF moved<>s.starts_at THEN
   UPDATE pactaris.play_sessions SET starts_at=moved,version=version+1,updated_at=statement_timestamp() WHERE household_id=target AND id=s.id;
  END IF;
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.invalid';
 END IF;
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.plannerMove',(body->>'itemId')::uuid,jsonb_build_object('operationId',body->>'operationId','kind',body->>'kind'));
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied');
END $$;
REVOKE ALL ON FUNCTION pactaris.planner_move(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- Personal export (docs/PERSONAL_EXPORT.md): the sessions a person wrote, with whom they linked (not other
-- people's parts), and their own part in sessions they are linked to.
ALTER FUNCTION pactaris.account_export_page(uuid,uuid,text,text,integer) RENAME TO account_export_page_before_sessions;
CREATE FUNCTION pactaris.account_export_page(instance uuid,account uuid,section text,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[];rows jsonb;last text;
BEGIN
 IF section IS DISTINCT FROM 'playSessions' THEN RETURN pactaris.account_export_page_before_sessions(instance,account,section,after,max_rows); END IF;
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid'; END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
  SELECT k,row FROM (
   SELECT s.household_id::text||':'||s.id::text||':'||s.owner_id::text AS k,jsonb_build_object('role','writer','householdId',s.household_id,
     'session',to_jsonb(s)-'household_id','links',(SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',l.membership_id,'canEdit',l.can_edit) ORDER BY l.membership_id),'[]'::jsonb)
      FROM pactaris.play_session_members l WHERE l.household_id=s.household_id AND l.session_id=s.id)) AS row
    FROM pactaris.play_sessions s WHERE s.owner_id=ANY(members)
   UNION ALL
   SELECT l.household_id::text||':'||l.session_id::text||':'||l.membership_id::text,jsonb_build_object('role','linked','householdId',l.household_id,
     'sessionId',l.session_id,'membershipId',l.membership_id,'canEdit',l.can_edit,'preparation',l.preparation,'aftercare',l.aftercare,'updatedAt',l.updated_at)
    FROM pactaris.play_session_members l WHERE l.membership_id=ANY(members)) x
  WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section',section,'records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
REVOKE ALL ON FUNCTION pactaris.account_export_page(uuid,uuid,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pactaris.account_export_page_before_sessions(uuid,uuid,text,text,integer) FROM PUBLIC;

-- Account erasure (docs/ACCOUNT_DELETION.md): a person's sessions and their own parts are personal notes and
-- are removed with the account, before the existing erasure runs.
ALTER FUNCTION pactaris.account_erase_content(uuid,uuid) RENAME TO account_erase_content_before_sessions;
CREATE FUNCTION pactaris.account_erase_content(target uuid,account uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[];
BEGIN
 SELECT array_agg(id) INTO members FROM pactaris.memberships WHERE household_id=target AND account_id=account;
 IF members IS NOT NULL THEN
  DELETE FROM pactaris.calendar_hidden WHERE household_id=target AND resource_id IN (SELECT id FROM pactaris.play_sessions WHERE household_id=target AND owner_id=ANY(members));
  DELETE FROM pactaris.play_sessions WHERE household_id=target AND owner_id=ANY(members);
  DELETE FROM pactaris.play_session_members WHERE household_id=target AND membership_id=ANY(members);
 END IF;
 RETURN pactaris.account_erase_content_before_sessions(target,account);
END $$;
REVOKE ALL ON FUNCTION pactaris.account_erase_content(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION pactaris.account_erase_content_before_sessions(uuid,uuid) FROM PUBLIC;
