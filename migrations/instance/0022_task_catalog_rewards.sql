CREATE FUNCTION pactaris.prepare_task_catalog_reward(target uuid, instance uuid, actor uuid, operation uuid,
 member uuid, item uuid, version_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE reward jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.partner.operation.'||operation::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
  IF EXISTS(SELECT 1 FROM pactaris.partner_receipts WHERE operation_id=operation) THEN
    -- The normal command checks the existing receipt's actor, membership and fingerprint.
    RETURN '{}'::jsonb;
  END IF;
  SELECT jsonb_build_object('title',v.fields->>'title','description',v.fields->>'description') INTO reward
  FROM pactaris.catalog_items c JOIN pactaris.catalog_versions v
    ON v.household_id=c.household_id AND v.item_id=c.id AND v.version=c.version
  JOIN pactaris.memberships m ON m.household_id=c.household_id AND m.id=c.creator_membership_id
  JOIN pactaris.households h ON h.id=m.household_id
  WHERE c.household_id=target AND c.id=item AND c.version=version_id AND c.state='draft'
    AND m.id=member AND m.account_id=actor AND m.status='active' AND h.instance_id=instance AND h.status<>'closed';
  IF reward IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.denied'; END IF;
  RETURN jsonb_build_object('rewardSelection',jsonb_build_object('itemId',item,'version',version_id::text),'sharedReward',reward);
END $$;
REVOKE ALL ON FUNCTION pactaris.prepare_task_catalog_reward(uuid,uuid,uuid,uuid,uuid,uuid,bigint) FROM PUBLIC;
