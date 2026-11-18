CREATE FUNCTION pactaris.habit_trend(target uuid,instance uuid,actor uuid,member uuid,routine uuid,revision_id bigint,anchor date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 WITH definition AS (
  SELECT v.fields FROM pactaris.routines r
  JOIN pactaris.routine_revisions v ON v.household_id=r.household_id AND v.routine_id=r.id AND v.revision=revision_id
  JOIN pactaris.memberships m ON m.household_id=r.household_id AND m.id=r.creator_membership_id
  JOIN pactaris.households h ON h.id=r.household_id
  WHERE r.household_id=target AND r.id=routine AND r.kind='habit'
    AND m.id=member AND m.account_id=actor AND m.status='active'
    AND h.instance_id=instance AND h.status<>'closed'
 ), buckets AS (
  SELECT period.local_day,period.start_at FROM definition d
  CROSS JOIN generate_series(0,6) AS offset_days(n)
  CROSS JOIN LATERAL pactaris.routine_period(d.fields,
    anchor - n * CASE WHEN d.fields->>'period'='weekly' THEN 7 ELSE 1 END) AS period
  WHERE period.local_day>=date '1900-01-01'
 ), totals AS (
  SELECT b.local_day,coalesce(sum(e.count),0) AS total
  FROM buckets b LEFT JOIN pactaris.progress_events e
   ON e.household_id=target AND e.routine_id=routine AND e.revision=revision_id
   AND e.kind='habit' AND e.reversed_at IS NULL AND e.period_start=b.start_at
  GROUP BY b.local_day
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('date',to_char(local_day,'YYYY-MM-DD'),'count',total)
   ORDER BY local_day),'[]'::jsonb) FROM totals
$$;
REVOKE ALL ON FUNCTION pactaris.habit_trend(uuid,uuid,uuid,uuid,uuid,bigint,date) FROM PUBLIC;
