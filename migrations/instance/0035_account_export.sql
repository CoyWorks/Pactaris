-- Complete personal export across every membership the account has, or had, on this
-- Instance (docs/PERSONAL_EXPORT.md). Each section pages by a stable text key. Only
-- records the person created, authored, participates in or receives are included;
-- household administration grants nothing extra.
CREATE FUNCTION pactaris.account_export_page(instance uuid,account uuid,section text,after text,max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE members uuid[]; rows jsonb; last text;
BEGIN
 IF instance IS NULL OR account IS NULL OR max_rows NOT BETWEEN 1 AND 25 OR coalesce(length(after),0)>200 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 SELECT coalesce(array_agg(m.id),'{}') INTO members FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
  WHERE h.instance_id=instance AND m.account_id=account;
 IF section='memberships' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT m.household_id::text||':'||m.id::text AS k,jsonb_build_object('householdId',m.household_id,'membershipId',m.id,
    'status',m.status,'technicalRole',m.technical_role,'alias',m.display_name,'createdAt',m.created_at,'endedAt',m.ended_at,
    'household',CASE WHEN m.status='active' THEN jsonb_build_object('name',h.display_name,'timeZone',h.time_zone,'status',h.status) END) AS row
   FROM pactaris.memberships m JOIN pactaris.households h ON h.id=m.household_id
   WHERE m.id=ANY(members) AND m.household_id::text||':'||m.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='limits' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT l.household_id::text||':'||l.membership_id::text AS k,jsonb_build_object('householdId',l.household_id,'membershipId',l.membership_id,'version',l.version,'limits',l.limits) AS row
   FROM pactaris.personal_limits l WHERE l.membership_id=ANY(members) AND l.household_id::text||':'||l.membership_id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='tasks' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT t.household_id::text||':'||t.id::text AS k,to_jsonb(t) AS row
   FROM pactaris.tasks t WHERE t.creator_membership_id=ANY(members) AND t.household_id::text||':'||t.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='documents' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT d.household_id::text||':'||d.id::text AS k,to_jsonb(d)||jsonb_build_object(
    'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v)-'household_id' ORDER BY v.version),'[]') FROM pactaris.document_versions v WHERE v.household_id=d.household_id AND v.document_id=d.id),
    'attachment',(SELECT jsonb_build_object('version',a.version,'base64',encode(a.bytes,'base64')) FROM pactaris.draft_attachments a WHERE a.household_id=d.household_id AND a.document_id=d.id)) AS row
   FROM pactaris.documents d WHERE d.creator_membership_id=ANY(members) AND d.state<>'deleted' AND d.household_id::text||':'||d.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='acknowledgements' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT a.household_id::text||':'||a.document_id::text||':'||lpad(a.version::text,20,'0')||':'||a.membership_id::text AS k,to_jsonb(a) AS row
   FROM pactaris.document_acknowledgements a WHERE a.membership_id=ANY(members)
    AND a.household_id::text||':'||a.document_id::text||':'||lpad(a.version::text,20,'0')||':'||a.membership_id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='routines' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT o.household_id::text||':'||o.id::text AS k,to_jsonb(o)||jsonb_build_object(
    'revisions',(SELECT coalesce(jsonb_agg(to_jsonb(v)-'household_id' ORDER BY v.revision),'[]') FROM pactaris.routine_revisions v WHERE v.household_id=o.household_id AND v.routine_id=o.id),
    'progress',(SELECT coalesce(jsonb_agg(to_jsonb(e)-'household_id' ORDER BY e.occurred_at,e.id),'[]') FROM pactaris.progress_events e WHERE e.household_id=o.household_id AND e.routine_id=o.id)) AS row
   FROM pactaris.routines o WHERE o.creator_membership_id=ANY(members) AND o.household_id::text||':'||o.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='catalog' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT i.household_id::text||':'||i.id::text AS k,to_jsonb(i)||jsonb_build_object(
    'versions',(SELECT coalesce(jsonb_agg(to_jsonb(v)-'household_id' ORDER BY v.version),'[]') FROM pactaris.catalog_versions v WHERE v.household_id=i.household_id AND v.item_id=i.id)) AS row
   FROM pactaris.catalog_items i WHERE i.creator_membership_id=ANY(members) AND i.household_id::text||':'||i.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='partnerTasks' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT t.household_id::text||':'||t.id::text AS k,to_jsonb(t)||jsonb_build_object(
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e)-'household_id' ORDER BY e.version),'[]') FROM pactaris.partner_events e WHERE e.household_id=t.household_id AND e.task_id=t.id)) AS row
   FROM pactaris.partner_tasks t WHERE (t.creator_id=ANY(members) OR t.assignee_id=ANY(members)) AND t.household_id::text||':'||t.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='series' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT s.household_id::text||':'||s.id::text AS k,to_jsonb(s)-'safety_snapshot' AS row
   FROM pactaris.task_series s WHERE (s.creator_id=ANY(members) OR s.assignee_id=ANY(members)) AND s.household_id::text||':'||s.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='personalSeries' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT s.household_id::text||':'||s.id::text||':'||lpad(s.version::text,20,'0') AS k,to_jsonb(s) AS row
   FROM pactaris.personal_task_series s WHERE s.creator_id=ANY(members)
    AND s.household_id::text||':'||s.id::text||':'||lpad(s.version::text,20,'0')>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='checkins' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT c.household_id::text||':'||c.id::text AS k,to_jsonb(c) AS row
   FROM pactaris.shared_checkins c WHERE c.author_id=ANY(members) AND c.household_id::text||':'||c.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='relationships' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT x.household_id::text||':'||x.id::text AS k,to_jsonb(x)||jsonb_build_object(
    'participants',(SELECT jsonb_agg(jsonb_build_object('membershipId',p.membership_id,'decision',p.decision,'decidedAt',p.decided_at) ORDER BY p.membership_id) FROM pactaris.relationship_participants p WHERE p.household_id=x.household_id AND p.relationship_id=x.id),
    'roles',(SELECT coalesce(jsonb_agg(to_jsonb(o)-'household_id' ORDER BY o.id),'[]') FROM pactaris.relationship_roles o WHERE o.household_id=x.household_id AND o.relationship_id=x.id)) AS row
   FROM pactaris.relationships x WHERE EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=x.household_id AND p.relationship_id=x.id AND p.membership_id=ANY(members))
    AND x.household_id::text||':'||x.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='agreements' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT v.household_id::text||':'||v.agreement_id::text||':'||lpad(v.version::text,20,'0') AS k,jsonb_build_object('householdId',v.household_id,
    'agreementId',v.agreement_id,'relationshipId',a.relationship_id,'version',v.version,'terms',v.terms,'expiresAt',v.expires_at,'revoked',v.revoked,'createdAt',v.created_at,
    'ownDecisions',(SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',d.membership_id,'decision',d.decision,'decidedAt',d.decided_at)),'[]') FROM pactaris.agreement_decisions d
      WHERE d.household_id=v.household_id AND d.agreement_id=v.agreement_id AND d.version=v.version AND d.membership_id=ANY(members))) AS row
   FROM pactaris.agreement_versions v JOIN pactaris.agreements a ON a.household_id=v.household_id AND a.id=v.agreement_id
   WHERE EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=a.household_id AND p.relationship_id=a.relationship_id AND p.membership_id=ANY(members))
    AND v.household_id::text||':'||v.agreement_id::text||':'||lpad(v.version::text,20,'0')>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='redemptions' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT x.household_id::text||':'||x.id::text AS k,to_jsonb(x)||jsonb_build_object(
    'ledger',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',e.kind,'createdAt',e.created_at) ORDER BY e.created_at),'[]') FROM pactaris.reward_point_entries e WHERE e.household_id=x.household_id AND e.redemption_id=x.id)) AS row
   FROM pactaris.reward_redemptions x WHERE (x.issuer_id=ANY(members) OR x.recipient_id=ANY(members)) AND x.household_id::text||':'||x.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSIF section='inbox' THEN
  SELECT jsonb_agg(r.row ORDER BY r.k),max(r.k) INTO rows,last FROM (
   SELECT i.household_id::text||':'||i.id::text AS k,to_jsonb(i) AS row
   FROM pactaris.task_inbox i WHERE i.recipient=ANY(members) AND i.household_id::text||':'||i.id::text>coalesce(after,'') ORDER BY 1 LIMIT max_rows) r;
 ELSE
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='account.invalid';
 END IF;
 rows=coalesce(rows,'[]'::jsonb);
 RETURN jsonb_build_object('section',section,'records',rows,'next',CASE WHEN jsonb_array_length(rows)=max_rows THEN last END);
END $$;
REVOKE ALL ON FUNCTION pactaris.account_export_page(uuid,uuid,text,text,integer) FROM PUBLIC;
