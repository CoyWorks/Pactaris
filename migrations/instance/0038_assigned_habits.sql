-- Habits a Dom sets for a sub, with automatic outcomes (docs/HOUSEHOLD_AUTHORITY.md), and
-- per-sub permissions. Outcomes only run with live points-and-punishments authority, an active
-- household, no pause on either person and no blocked activity; otherwise the period is recorded
-- as skipped. Nothing is applied retroactively after a pause or a link has ended.
ALTER TABLE pactaris.authority_links ADD COLUMN can_spend_points boolean NOT NULL DEFAULT true,
 ADD COLUMN can_propose boolean NOT NULL DEFAULT true;

CREATE TABLE pactaris.authority_habits (
 household_id uuid NOT NULL,id uuid NOT NULL,holder_id uuid NOT NULL,subject_id uuid NOT NULL,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '' CHECK(char_length(description)<=500),
 period text NOT NULL CHECK(period IN ('daily','weekly')),mode text NOT NULL CHECK(mode IN ('minimum','maximum')),
 goal integer NOT NULL CHECK(goal BETWEEN 0 AND 1000),time_zone text NOT NULL CHECK(char_length(time_zone) BETWEEN 1 AND 100),
 reward_points integer CHECK(reward_points BETWEEN 1 AND 10000),penalty_points integer CHECK(penalty_points BETWEEN 1 AND 10000),
 punishment text CHECK(char_length(punishment) BETWEEN 1 AND 120),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','archived')),version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),next_period date NOT NULL,
 PRIMARY KEY(household_id,id),CHECK(holder_id<>subject_id),CHECK(mode='maximum' OR goal>=1),
 FOREIGN KEY(household_id,holder_id) REFERENCES pactaris.memberships(household_id,id),
 FOREIGN KEY(household_id,subject_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX authority_habits_subject ON pactaris.authority_habits(household_id,subject_id) WHERE state<>'archived';
CREATE TABLE pactaris.authority_habit_entries (
 household_id uuid NOT NULL,id uuid NOT NULL,habit_id uuid NOT NULL,member_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,count integer NOT NULL CHECK(count BETWEEN 1 AND 1000),reversed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,habit_id) REFERENCES pactaris.authority_habits(household_id,id),
 FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE INDEX authority_habit_entries_habit ON pactaris.authority_habit_entries(household_id,habit_id,occurred_at);
CREATE TABLE pactaris.authority_habit_results (
 household_id uuid NOT NULL,habit_id uuid NOT NULL,period_start date NOT NULL,total integer NOT NULL,
 result text NOT NULL CHECK(result IN ('reached','missed','skipped')),outcome jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(household_id,habit_id,period_start),
 FOREIGN KEY(household_id,habit_id) REFERENCES pactaris.authority_habits(household_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['authority_habits','authority_habit_entries','authority_habit_results'] LOOP
  EXECUTE format('ALTER TABLE pactaris.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE pactaris.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY command_only ON pactaris.%I FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor())',name);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.habit_period_start(period text,zone text,at timestamptz) RETURNS date
LANGUAGE sql STABLE SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT CASE WHEN period='weekly' THEN date_trunc('week',(at AT TIME ZONE zone))::date ELSE (at AT TIME ZONE zone)::date END
$$;
CREATE FUNCTION pactaris.habit_period_total(target uuid,habit uuid,period text,zone text,start_day date) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT coalesce(sum(e.count),0)::integer FROM pactaris.authority_habit_entries e
  WHERE e.household_id=target AND e.habit_id=habit AND NOT e.reversed
   AND e.occurred_at>=(start_day::timestamp AT TIME ZONE zone)
   AND e.occurred_at<((start_day+CASE WHEN period='weekly' THEN 7 ELSE 1 END)::timestamp AT TIME ZONE zone)
$$;
REVOKE ALL ON FUNCTION pactaris.habit_period_total(uuid,uuid,text,text,date) FROM PUBLIC;

-- A punishment task through the pair's backing direct policy, with the usual inbox notice.
CREATE FUNCTION pactaris.authority_punish(target uuid,holder uuid,subject uuid,operation uuid,title text,description text,exchange uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE pair pactaris.authority_pairs;revision bigint;
BEGIN
 PERFORM pactaris.authority_sync(target);
 SELECT * INTO pair FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=holder AND subject_id=subject;
 SELECT version INTO revision FROM pactaris.assignment_policies WHERE household_id=target AND id=pair.policy_id AND state='active';
 IF pair.policy_id IS NULL OR revision IS NULL THEN RETURN false; END IF;
 INSERT INTO pactaris.partner_receipts VALUES(operation,target,holder,encode(sha256(convert_to('punishment:'||operation::text,'UTF8')),'hex'),
  jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',holder,'status','applied','taskId',operation));
 INSERT INTO pactaris.partner_tasks(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,fields,policy_id,policy_version,state)
  VALUES(target,operation,holder,subject,pair.agreement_id,1,jsonb_build_object('title',title,'description',description,'priority','normal','dueAt',NULL),pair.policy_id,revision,'assigned');
 INSERT INTO pactaris.partner_events(household_id,task_id,version,action,actor_id,note) VALUES(target,operation,1,'partnerAssign',holder,'');
 INSERT INTO pactaris.authority_punishments VALUES(target,operation,holder,subject,exchange);
 INSERT INTO pactaris.partner_outbox VALUES(operation,target,'partner.partnerAssign',now());
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_punish(uuid,uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;

-- Evaluate ended periods: bounded per call, idempotent per habit and period.
CREATE FUNCTION pactaris.run_authority_habits(instance uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE x pactaris.authority_habits;job record;h pactaris.households;total integer;outcome text;applied jsonb;allowed boolean;done integer:=0;step integer;
BEGIN
 FOR job IN SELECT a.household_id,a.id FROM pactaris.authority_habits a JOIN pactaris.households hh ON hh.id=a.household_id
  WHERE hh.instance_id=instance AND a.state='active'
   AND a.next_period<pactaris.habit_period_start(a.period,a.time_zone,now()) ORDER BY a.next_period,a.id LIMIT 32 LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pactaris.household.'||job.household_id::text,0)) THEN CONTINUE; END IF;
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=job.household_id AND id=job.id AND state='active' FOR UPDATE;
  IF NOT FOUND OR x.next_period>=pactaris.habit_period_start(x.period,x.time_zone,now()) THEN CONTINUE; END IF;
  SELECT * INTO h FROM pactaris.households WHERE id=x.household_id;
  step=CASE WHEN x.period='weekly' THEN 7 ELSE 1 END;
  total=pactaris.habit_period_total(x.household_id,x.id,x.period,x.time_zone,x.next_period);
  outcome=CASE WHEN (x.mode='minimum' AND total>=x.goal) OR (x.mode='maximum' AND total<=x.goal) THEN 'reached' ELSE 'missed' END;
  allowed=h.status='active' AND pactaris.authority_area(x.household_id,x.holder_id,x.subject_id,'outcomes')
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m LEFT JOIN pactaris.personal_limits l ON l.household_id=m.household_id AND l.membership_id=m.id
    WHERE m.household_id=x.household_id AND m.id IN (x.holder_id,x.subject_id) AND (m.status<>'active' OR m.safety_paused
     OR coalesce(l.limits->'blockedActivities','[]'::jsonb)?CASE WHEN outcome='reached' THEN 'reward' ELSE 'consequence' END));
  applied='{}'::jsonb;
  IF allowed AND h.points_enabled AND outcome='reached' AND x.reward_points IS NOT NULL THEN
   INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,x.reward_points,left(x.title,200));
   applied=applied||jsonb_build_object('points',x.reward_points);
  ELSIF allowed AND outcome='missed' THEN
   IF h.points_enabled AND x.penalty_points IS NOT NULL THEN
    INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,-x.penalty_points,left(x.title,200));
    applied=applied||jsonb_build_object('points',-x.penalty_points);
   END IF;
   IF x.punishment IS NOT NULL THEN
    applied=applied||jsonb_build_object('punishmentTaskId',gen_random_uuid());
    IF NOT pactaris.authority_punish(x.household_id,x.holder_id,x.subject_id,(applied->>'punishmentTaskId')::uuid,x.punishment,left(x.title,500),NULL) THEN
     applied=applied-'punishmentTaskId';
    END IF;
   END IF;
  END IF;
  INSERT INTO pactaris.authority_habit_results(household_id,habit_id,period_start,total,result,outcome)
   VALUES(x.household_id,x.id,x.next_period,total,CASE WHEN allowed THEN outcome ELSE 'skipped' END,applied) ON CONFLICT DO NOTHING;
  -- Periods missed while the worker was down are recorded once without outcomes.
  UPDATE pactaris.authority_habits SET next_period=CASE WHEN next_period+step<pactaris.habit_period_start(period,time_zone,now())-step*7
   THEN pactaris.habit_period_start(period,time_zone,now())-step ELSE next_period+step END WHERE household_id=x.household_id AND id=x.id;
  done=done+1;
 END LOOP;
 RETURN CASE WHEN done=0 THEN 'idle' ELSE 'processed' END;
END $$;
REVOKE ALL ON FUNCTION pactaris.run_authority_habits(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.authority_habit_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;x pactaris.authority_habits;e pactaris.authority_habit_entries;
 prior pactaris.authority_receipts;answer jsonb;items jsonb;resource uuid;f jsonb;zone text;
BEGIN
 IF action IS NULL OR action NOT IN ('habitList','habitSave','habitState','habitRecord','habitReverse') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.authority.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 IF action='habitList' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('habitId',y.id,'holderId',y.holder_id,'holderName',hm.display_name,'subjectId',y.subject_id,'subjectName',sm.display_name,
    'title',y.title,'description',y.description,'period',y.period,'mode',y.mode,'target',y.goal,'timeZone',y.time_zone,
    'rewardPoints',y.reward_points,'penaltyPoints',y.penalty_points,'punishment',y.punishment,'state',y.state,'version',y.version::text,
    'periodStart',pactaris.habit_period_start(y.period,y.time_zone,now()),
    'currentTotal',pactaris.habit_period_total(target,y.id,y.period,y.time_zone,pactaris.habit_period_start(y.period,y.time_zone,now())),
    'canEdit',y.holder_id=m.id OR pactaris.authority_area(target,m.id,y.subject_id,'manage'),'canRecord',m.id IN (y.subject_id,y.holder_id),
    'results',(SELECT coalesce(jsonb_agg(jsonb_build_object('periodStart',r.period_start,'total',r.total,'result',r.result) ORDER BY r.period_start DESC),'[]'::jsonb)
      FROM (SELECT * FROM pactaris.authority_habit_results WHERE household_id=target AND habit_id=y.id ORDER BY period_start DESC LIMIT 7) r)
   ) ORDER BY y.subject_id,y.created_at),'[]'::jsonb) INTO items
   FROM (SELECT * FROM pactaris.authority_habits z WHERE z.household_id=target AND z.state<>'archived'
    AND (m.id IN (z.subject_id,z.holder_id) OR pactaris.authority_area(target,m.id,z.subject_id,'tasks')) ORDER BY z.created_at LIMIT 50) y
   JOIN pactaris.memberships hm ON hm.household_id=target AND hm.id=y.holder_id JOIN pactaris.memberships sm ON sm.household_id=target AND sm.id=y.subject_id;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','habits',items);
 END IF;
 SELECT * INTO prior FROM pactaris.authority_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='habitSave' THEN
  f=payload->'fields';zone=f->>'timeZone';
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
  IF payload->>'habitId' IS NULL THEN
   SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
   IF NOT FOUND OR NOT pactaris.authority_area(target,m.id,other.id,'tasks') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF h.status<>'active' OR m.safety_paused OR other.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
   IF (SELECT count(*) FROM pactaris.authority_habits WHERE household_id=target AND subject_id=other.id AND state<>'archived')>=50 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
   INSERT INTO pactaris.authority_habits(household_id,id,holder_id,subject_id,title,description,period,mode,goal,time_zone,reward_points,penalty_points,punishment,next_period)
    VALUES(target,operation,m.id,other.id,f->>'title',f->>'description',f->>'period',f->>'mode',(f->>'target')::integer,zone,
     (f->>'rewardPoints')::integer,(f->>'penaltyPoints')::integer,f->>'punishment',pactaris.habit_period_start(f->>'period',zone,now()));
   resource=operation;
  ELSE
   SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid FOR UPDATE;
   IF NOT FOUND OR NOT (x.holder_id=m.id OR pactaris.authority_area(target,m.id,x.subject_id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   UPDATE pactaris.authority_habits SET title=f->>'title',description=f->>'description',mode=f->>'mode',goal=(f->>'target')::integer,
    reward_points=(f->>'rewardPoints')::integer,penalty_points=(f->>'penaltyPoints')::integer,punishment=f->>'punishment',version=version+1
    WHERE household_id=target AND id=x.id;
   resource=x.id;
  END IF;
 ELSIF action='habitState' THEN
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT (x.holder_id=m.id OR pactaris.authority_area(target,m.id,x.subject_id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF x.version::text IS DISTINCT FROM payload->>'version' OR x.state='archived' OR payload->>'state'=x.state THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  -- Resuming starts at the current period; paused periods are never evaluated afterwards.
  UPDATE pactaris.authority_habits SET state=payload->>'state',version=version+1,
   next_period=CASE WHEN payload->>'state'='active' THEN pactaris.habit_period_start(period,time_zone,now()) ELSE next_period END
   WHERE household_id=target AND id=x.id;
  resource=x.id;
 ELSIF action='habitRecord' THEN
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=(payload->>'habitId')::uuid AND state='active';
  IF NOT FOUND OR m.id NOT IN (x.subject_id,x.holder_id) OR (m.id=x.holder_id AND NOT pactaris.authority_area(target,m.id,x.subject_id,'tasks')) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' OR EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id IN (x.subject_id,x.holder_id) AND safety_paused) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  INSERT INTO pactaris.authority_habit_entries(household_id,id,habit_id,member_id,occurred_at,count) VALUES(target,operation,x.id,m.id,statement_timestamp(),(payload->>'count')::integer);
  resource=operation;
 ELSE
  SELECT * INTO e FROM pactaris.authority_habit_entries WHERE household_id=target AND id=(payload->>'entryId')::uuid FOR UPDATE;
  SELECT * INTO x FROM pactaris.authority_habits WHERE household_id=target AND id=e.habit_id;
  IF e.id IS NULL OR m.id NOT IN (e.member_id,x.holder_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF e.reversed OR pactaris.habit_period_start(x.period,x.time_zone,e.occurred_at)<x.next_period THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.authority_habit_entries SET reversed=true WHERE household_id=target AND id=e.id;
  resource=e.id;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_habit_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Identical to 0037 apart from the spending permission.
CREATE OR REPLACE FUNCTION pactaris.activity_guard(target uuid,instance uuid,actor uuid,member_id uuid,agreement uuid,expected_version bigint,activity text,expected_epoch bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; a pactaris.agreements; v pactaris.agreement_versions; ap pactaris.authority_pairs;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status<>'active' OR h.safety_version IS DISTINCT FROM expected_epoch OR activity IS NULL OR activity NOT IN ('task','protocol','reward','consequence','session','reminder') THEN RETURN false; END IF;
 -- Authority-backed agreement: consent was given once by linking. Live authority, membership,
 -- pause, relationship hold and blocked activities decide; per-version acceptance and expiry do not.
 SELECT * INTO ap FROM pactaris.authority_pairs WHERE household_id=target AND agreement_id=agreement;
 IF FOUND THEN
  IF expected_version IS DISTINCT FROM (SELECT version FROM pactaris.agreements WHERE household_id=target AND id=agreement) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=member_id AND account_id=actor AND status='active' AND id IN (ap.holder_id,ap.subject_id)) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.memberships x LEFT JOIN pactaris.personal_limits l ON l.household_id=x.household_id AND l.membership_id=x.id
    WHERE x.household_id=target AND x.id IN (ap.holder_id,ap.subject_id) AND (x.status<>'active' OR x.safety_paused OR coalesce(l.limits->'blockedActivities','[]'::jsonb)?activity)) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=ap.relationship_id AND status='active')
   OR EXISTS(SELECT 1 FROM pactaris.relationship_holds WHERE household_id=target AND relationship_id=ap.relationship_id AND paused) THEN RETURN false; END IF;
  -- A Dom can switch off spending points for a sub (any of the sub's Doms; the strictest wins).
  IF activity='reward' AND member_id=ap.subject_id AND EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=ap.subject_id AND NOT can_spend_points) THEN RETURN false; END IF;
  RETURN pactaris.authority_area(target,ap.holder_id,ap.subject_id,CASE WHEN activity IN ('reward','consequence') THEN 'outcomes' ELSE 'tasks' END);
 END IF;
 SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=agreement AND version=expected_version;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pactaris.relationships WHERE household_id=target AND id=a.relationship_id AND status='active') OR
  NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
   WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND m.id=member_id AND m.account_id=actor AND m.status='active') THEN RETURN false; END IF;
 SELECT * INTO v FROM pactaris.agreement_versions WHERE household_id=target AND agreement_id=agreement AND version=expected_version;
 IF NOT FOUND OR v.revoked OR v.expires_at<=now() OR NOT (v.terms->'activities' ? activity) THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
  LEFT JOIN pactaris.personal_limits l ON l.household_id=p.household_id AND l.membership_id=p.membership_id
  LEFT JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.membership_id=p.membership_id
  LEFT JOIN pactaris.agreement_decisions d ON d.household_id=target AND d.agreement_id=agreement AND d.version=expected_version AND d.membership_id=p.membership_id
  WHERE p.household_id=target AND p.relationship_id=a.relationship_id AND (m.status<>'active' OR m.safety_paused OR coalesce(rh.paused,false) OR
   coalesce(l.limits->'blockedActivities','[]'::jsonb) ? activity OR d.decision IS DISTINCT FROM 'accepted' OR d.household_epoch IS DISTINCT FROM h.safety_version OR
   d.member_epoch IS DISTINCT FROM m.safety_epoch OR d.relationship_epoch IS DISTINCT FROM coalesce(rh.epoch,1) OR d.limits_version IS DISTINCT FROM coalesce(l.version,1)));
END $$;

-- Identical to 0036 apart from the proposal permission.
CREATE OR REPLACE FUNCTION pactaris.exchange_allowed(target uuid,kind text,author uuid,recipient uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT CASE kind
  WHEN 'permission' THEN pactaris.exchange_authority(target,recipient,author)
  WHEN 'journal' THEN pactaris.exchange_authority(target,recipient,author)
  WHEN 'breach' THEN pactaris.exchange_authority(target,author,recipient)
  WHEN 'proposal' THEN (pactaris.exchange_authority(target,recipient,author) OR pactaris.exchange_authority(target,author,recipient))
   AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=author AND NOT can_propose)
  ELSE false END
$$;

-- Identical to 0037 apart from the permissions and the shared punishment helper.
CREATE OR REPLACE FUNCTION pactaris.authority_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;other pactaris.memberships;l pactaris.authority_links;d pactaris.authority_delegations;
 prior pactaris.authority_receipts;pair pactaris.authority_pairs;answer jsonb;resource uuid;links jsonb;delegations jsonb;members jsonb;powers jsonb;
 adjustments jsonb;ends timestamptz;policy_version bigint;involved boolean;
BEGIN
 IF action IS NULL OR action NOT IN ('authorityList','linkInvite','linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke',
   'rankSet','visibilitySet','pointsAdjust','punishmentGive') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.authority.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;

 IF action='authorityList' THEN
  involved=EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND m.id IN (dom_id,sub_id));
  SELECT coalesce(jsonb_agg(jsonb_build_object('linkId',x.id,'domId',x.dom_id,'domName',dm.display_name,'subId',x.sub_id,'subName',sm.display_name,
    'state',x.state,'label',x.label,'rankAuthority',x.rank_authority,'private',x.private,'canSpendPoints',x.can_spend_points,'canPropose',x.can_propose,'version',x.version::text,
    'role',CASE WHEN x.dom_id=m.id THEN 'dom' WHEN x.sub_id=m.id THEN 'sub' ELSE 'viewer' END) ORDER BY x.created_at,x.id),'[]'::jsonb) INTO links
   FROM (SELECT * FROM pactaris.authority_links z WHERE z.household_id=target AND z.state<>'ended'
    AND (m.id IN (z.dom_id,z.sub_id)
     OR EXISTS(SELECT 1 FROM pactaris.authority_delegations e WHERE e.household_id=target AND e.link_id=z.id AND e.delegate_id=m.id AND e.state='active')
     OR (z.state='active' AND h.subs_visible AND NOT z.private AND involved))
    ORDER BY z.created_at,z.id LIMIT 100) x
   JOIN pactaris.memberships dm ON dm.household_id=target AND dm.id=x.dom_id JOIN pactaris.memberships sm ON sm.household_id=target AND sm.id=x.sub_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('delegationId',e.id,'linkId',e.link_id,'delegateId',e.delegate_id,'delegateName',dm.display_name,
    'tasks',e.tasks,'outcomes',e.outcomes,'endsAt',e.ends_at,'version',e.version::text) ORDER BY e.id),'[]'::jsonb) INTO delegations
   FROM pactaris.authority_delegations e JOIN pactaris.authority_links z ON z.household_id=e.household_id AND z.id=e.link_id AND z.state='active'
   JOIN pactaris.memberships dm ON dm.household_id=e.household_id AND dm.id=e.delegate_id
   WHERE e.household_id=target AND e.state='active' AND m.id IN (z.dom_id,z.sub_id,e.delegate_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'name',o.display_name,'owner',o.technical_role='owner',
    'rank',CASE WHEN o.id=m.id OR (h.subs_visible AND involved) OR pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'manage') THEN o.sub_rank END) ORDER BY o.display_name,o.id),'[]'::jsonb) INTO members
   FROM (SELECT * FROM pactaris.memberships WHERE household_id=target AND status='active' ORDER BY display_name,id LIMIT 100) o;
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',o.id,'tasks',pactaris.authority_area(target,m.id,o.id,'tasks'),
    'outcomes',pactaris.authority_area(target,m.id,o.id,'outcomes'),'manage',pactaris.authority_area(target,m.id,o.id,'manage'),
    'points',pactaris.authority_points(target,o.id)::text) ORDER BY o.id),'[]'::jsonb) INTO powers
   FROM pactaris.memberships o WHERE o.household_id=target AND o.status='active' AND o.id<>m.id
    AND (pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'outcomes'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'recipientId',a.recipient_id,'issuerId',a.issuer_id,'points',a.points,'reason',a.reason,'createdAt',a.created_at) ORDER BY a.created_at DESC),'[]'::jsonb) INTO adjustments
   FROM (SELECT * FROM pactaris.point_adjustments WHERE household_id=target AND m.id IN (recipient_id,issuer_id) ORDER BY created_at DESC LIMIT 10) a;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','links',links,'delegations',delegations,
   'members',members,'powers',powers,'adjustments',adjustments,'subsVisible',h.subs_visible,'settingsVersion',h.authority_version::text,
   'canSetVisibility',m.technical_role='owner','myPoints',pactaris.authority_points(target,m.id)::text,'myRank',m.sub_rank);
 END IF;

 SELECT * INTO prior FROM pactaris.authority_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  RETURN prior.result;
 END IF;

 IF action='linkInvite' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subId')::uuid AND status='active';
  IF NOT FOUND OR other.id=m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state<>'ended' AND dom_id=m.id AND sub_id=other.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF (SELECT count(*) FROM pactaris.authority_links WHERE household_id=target AND state<>'ended')>=100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
  INSERT INTO pactaris.authority_links(household_id,id,dom_id,sub_id,label) VALUES(target,operation,m.id,other.id,payload->>'label');
  resource=operation;
 ELSIF action IN ('linkAccept','linkDecline','linkEnd','linkSettings') THEN
  SELECT * INTO l FROM pactaris.authority_links WHERE household_id=target AND id=(payload->>'linkId')::uuid FOR UPDATE;
  IF NOT FOUND OR (action IN ('linkAccept','linkDecline') AND l.sub_id<>m.id) OR (action='linkSettings' AND l.dom_id<>m.id) OR (action='linkEnd' AND m.id NOT IN (l.dom_id,l.sub_id)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF l.version::text IS DISTINCT FROM payload->>'version' OR l.state='ended' OR (action IN ('linkAccept','linkDecline') AND l.state<>'invited') OR (action='linkSettings' AND l.state<>'active') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF action='linkAccept' THEN
   IF h.status<>'active' OR m.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
   UPDATE pactaris.authority_links SET state='active',accepted_at=statement_timestamp(),version=version+1 WHERE household_id=target AND id=l.id;
  ELSIF action='linkSettings' THEN
   UPDATE pactaris.authority_links SET rank_authority=payload->>'rankAuthority',private=(payload->>'private')::boolean,
    can_spend_points=(payload->>'canSpendPoints')::boolean,can_propose=(payload->>'canPropose')::boolean,version=version+1 WHERE household_id=target AND id=l.id;
  ELSE
   -- Ending or declining is always possible, also during a pause.
   UPDATE pactaris.authority_links SET state='ended',ended_at=statement_timestamp(),ended_by=m.id,version=version+1 WHERE household_id=target AND id=l.id;
  END IF;
  resource=l.id;
 ELSIF action='delegationSet' THEN
  SELECT * INTO l FROM pactaris.authority_links WHERE household_id=target AND id=(payload->>'linkId')::uuid AND dom_id=m.id AND state='active';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'delegateId')::uuid AND status='active';
  IF NOT FOUND OR other.id IN (l.dom_id,l.sub_id) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  ends=(payload->>'endsAt')::timestamptz;
  IF ends IS NOT NULL AND ends<=statement_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid'; END IF;
  SELECT * INTO d FROM pactaris.authority_delegations WHERE household_id=target AND link_id=l.id AND delegate_id=other.id AND state='active' FOR UPDATE;
  IF coalesce(d.version,0)::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  IF d.id IS NULL THEN
   INSERT INTO pactaris.authority_delegations(household_id,id,link_id,delegate_id,tasks,outcomes,ends_at,created_by)
    VALUES(target,operation,l.id,other.id,(payload->>'tasks')::boolean,(payload->>'outcomes')::boolean,ends,m.id);
   resource=operation;
  ELSE
   UPDATE pactaris.authority_delegations SET tasks=(payload->>'tasks')::boolean,outcomes=(payload->>'outcomes')::boolean,ends_at=ends,version=version+1
    WHERE household_id=target AND id=d.id;
   resource=d.id;
  END IF;
 ELSIF action='delegationRevoke' THEN
  SELECT e.* INTO d FROM pactaris.authority_delegations e JOIN pactaris.authority_links z ON z.household_id=e.household_id AND z.id=e.link_id
   WHERE e.household_id=target AND e.id=(payload->>'delegationId')::uuid AND m.id IN (z.dom_id,z.sub_id,e.delegate_id) FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF d.version::text IS DISTINCT FROM payload->>'version' OR d.state<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.authority_delegations SET state='revoked',version=version+1 WHERE household_id=target AND id=d.id;
  resource=d.id;
 ELSIF action='rankSet' THEN
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
  IF NOT FOUND OR NOT (m.technical_role='owner' OR pactaris.authority_area(target,m.id,other.id,'manage')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF (payload->>'rank') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=other.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.memberships SET sub_rank=(payload->>'rank')::integer WHERE household_id=target AND id=other.id;
  resource=other.id;
 ELSIF action='visibilitySet' THEN
  IF m.technical_role<>'owner' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.authority_version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.households SET subs_visible=(payload->>'subsVisible')::boolean,authority_version=authority_version+1 WHERE id=target;
  resource=target;
 ELSE
  SELECT * INTO other FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'subjectId')::uuid AND status='active';
  IF NOT FOUND OR NOT pactaris.authority_area(target,m.id,other.id,'outcomes') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF h.status<>'active' OR m.safety_paused OR other.safety_paused THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF EXISTS(SELECT 1 FROM pactaris.personal_limits WHERE household_id=target AND membership_id=other.id AND coalesce(limits->'blockedActivities','[]'::jsonb)?'consequence')
   AND action='punishmentGive' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF action='pointsAdjust' THEN
   IF NOT h.points_enabled THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason)
    VALUES(target,operation,other.id,m.id,(payload->>'points')::integer,payload->>'reason');
  ELSE
   IF payload->>'exchangeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pactaris.exchanges WHERE household_id=target AND id=(payload->>'exchangeId')::uuid
     AND kind='breach' AND author_id=m.id AND recipient_id=other.id AND state<>'withdrawn') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF NOT pactaris.authority_punish(target,m.id,other.id,operation,payload->>'title',payload->>'description',(payload->>'exchangeId')::uuid) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  END IF;
  resource=operation;
 END IF;
 IF action IN ('linkAccept','linkDecline','linkEnd','linkSettings','delegationSet','delegationRevoke','rankSet') THEN PERFORM pactaris.authority_sync(target); END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;

-- Personal export also covers assigned habits and their entries.
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
  ) all_rows WHERE k>coalesce(after,'') ORDER BY k LIMIT max_rows) r;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section','authority','records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;

-- Departure archives habits of the leaving member; erasure blanks the text they wrote.
CREATE FUNCTION pactaris.habit_departure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  UPDATE pactaris.authority_habits SET state='archived',version=version+1 WHERE household_id=NEW.household_id AND NEW.id IN (holder_id,subject_id) AND state<>'archived';
 END IF;
 IF NEW.account_erased_at IS NOT NULL THEN
  UPDATE pactaris.authority_habits SET title=left(id::text,8),description='',punishment=CASE WHEN punishment IS NULL THEN NULL ELSE left(id::text,8) END,version=version+1
   WHERE household_id=NEW.household_id AND holder_id=NEW.id AND description||title<>'';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.habit_departure() FROM PUBLIC;
CREATE TRIGGER habit_departure AFTER UPDATE OF status,account_erased_at ON pactaris.memberships FOR EACH ROW EXECUTE FUNCTION pactaris.habit_departure();
