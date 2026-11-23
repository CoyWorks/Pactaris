-- Never issue delayed outcomes while a scheduled break is currently active.
CREATE OR REPLACE FUNCTION pactaris.run_authority_habits(instance uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE x pactaris.authority_habits;job record;h pactaris.households;total integer;outcome text;applied jsonb;allowed boolean;done integer:=0;step integer;streak integer;mr record;
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
  allowed=(x.skip_through IS NULL OR x.next_period>x.skip_through)
   AND NOT pactaris.habit_break_overlap(x.breaks,x.next_period,x.next_period+step-1)
   AND NOT pactaris.habit_break_overlap(x.breaks,(now() AT TIME ZONE x.time_zone)::date,(now() AT TIME ZONE x.time_zone)::date)
   AND NOT EXISTS(SELECT 1 FROM pactaris.authority_habit_results r WHERE r.household_id=x.household_id AND r.habit_id=x.id AND r.period_start=x.next_period)
   AND (x.period<>'daily' OR extract(isodow from x.next_period)::integer=ANY(x.weekdays))
   AND NOT EXISTS(SELECT 1 FROM pactaris.authority_pairs p JOIN pactaris.relationship_holds rh ON rh.household_id=p.household_id AND rh.relationship_id=p.relationship_id AND rh.paused WHERE p.household_id=x.household_id AND p.holder_id=x.holder_id AND p.subject_id=x.subject_id) AND h.status='active' AND pactaris.authority_area(x.household_id,x.holder_id,x.subject_id,'outcomes')
   AND NOT EXISTS(SELECT 1 FROM pactaris.memberships m LEFT JOIN pactaris.personal_limits l ON l.household_id=m.household_id AND l.membership_id=m.id
    WHERE m.household_id=x.household_id AND m.id IN (x.holder_id,x.subject_id) AND (m.status<>'active' OR m.safety_paused
     OR coalesce(l.limits->'blockedActivities','[]'::jsonb)?CASE WHEN outcome='reached' THEN 'reward' ELSE 'consequence' END));
  applied='{}'::jsonb;
  IF allowed AND outcome='reached' THEN
   IF h.points_enabled AND x.reward_points IS NOT NULL THEN
    INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,x.reward_points,left(x.title,200));
    applied=applied||jsonb_build_object('points',x.reward_points);
   END IF;
   IF h.points_enabled AND x.milestone_every IS NOT NULL THEN
    -- Streak including this reached period; a bonus every N reached in a row. Skipped (paused) periods are neutral.
    streak=1;
    FOR mr IN SELECT result FROM pactaris.authority_habit_results WHERE household_id=x.household_id AND habit_id=x.id AND period_start<x.next_period ORDER BY period_start DESC LOOP
     IF mr.result='reached' THEN streak=streak+1; ELSIF mr.result='missed' THEN EXIT; END IF;
    END LOOP;
    IF streak % x.milestone_every = 0 THEN
     INSERT INTO pactaris.point_adjustments(household_id,id,recipient_id,issuer_id,points,reason) VALUES(x.household_id,gen_random_uuid(),x.subject_id,x.holder_id,x.milestone_points,left(x.title,200));
     applied=applied||jsonb_build_object('milestonePoints',x.milestone_points,'streak',streak);
    END IF;
   END IF;
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

