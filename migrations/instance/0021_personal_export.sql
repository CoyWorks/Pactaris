CREATE FUNCTION pactaris.personal_export(target uuid, instance uuid, actor uuid, member uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE tasks jsonb; documents jsonb; truncated boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
    WHERE m.household_id=target AND m.id=member AND m.account_id=actor AND m.status='active'
      AND h.instance_id=instance AND h.status IN ('active','paused')
  ) THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) INTO tasks FROM (
    SELECT id,title,description,priority,due_at,state,created_at,updated_at
    FROM pactaris.tasks WHERE household_id=target AND creator_membership_id=member ORDER BY id LIMIT 6
  ) t;
  SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) INTO documents FROM (
    SELECT d.id,d.kind,d.state,v.title,v.body,v.category,d.created_at,d.updated_at
    FROM pactaris.documents d INNER JOIN pactaris.document_versions v
      ON v.household_id=d.household_id AND v.document_id=d.id AND v.version=d.version
    WHERE d.household_id=target AND d.creator_membership_id=member AND d.state<>'deleted' ORDER BY d.id LIMIT 3
  ) d;
  truncated=jsonb_array_length(tasks)>5 OR jsonb_array_length(documents)>2;
  RETURN jsonb_build_object('householdId',target,'tasks',tasks-5,'documents',documents-2,'truncated',truncated);
END $$;
REVOKE ALL ON FUNCTION pactaris.personal_export(uuid,uuid,uuid,uuid) FROM PUBLIC;
