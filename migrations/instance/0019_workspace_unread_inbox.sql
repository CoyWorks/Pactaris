CREATE INDEX task_inbox_unread ON pactaris.task_inbox(household_id,recipient) WHERE NOT read;

CREATE FUNCTION pactaris.workspace_has_unread(target uuid,instance uuid,actor uuid,member uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT EXISTS (
  SELECT 1 FROM pactaris.task_inbox i
  JOIN pactaris.memberships m ON m.household_id=i.household_id AND m.id=i.recipient
  JOIN pactaris.households h ON h.id=m.household_id
  WHERE i.household_id=target AND i.recipient=member AND NOT i.read
    AND m.account_id=actor AND m.status='active' AND h.instance_id=instance AND h.status<>'closed'
 )
$$;
REVOKE ALL ON FUNCTION pactaris.workspace_has_unread(uuid,uuid,uuid,uuid) FROM PUBLIC;
