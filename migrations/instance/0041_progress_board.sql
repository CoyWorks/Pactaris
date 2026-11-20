-- Backing relationships created for Dom links and delegations are bookkeeping, not relationships
-- people proposed. They are marked and left out of the Relationships list; authority manages them.
ALTER TABLE pactaris.relationships ADD COLUMN system boolean NOT NULL DEFAULT false;
UPDATE pactaris.relationships r SET system=true
 WHERE EXISTS(SELECT 1 FROM pactaris.agreements a JOIN pactaris.assignment_policies p ON p.household_id=a.household_id AND p.agreement_id=a.id
  JOIN pactaris.assignment_policy_events e ON e.household_id=p.household_id AND e.policy_id=p.id AND e.action='authorityGranted'
  WHERE a.household_id=r.household_id AND a.relationship_id=r.id);

-- Identical to 0037 apart from marking the backing relationship.
CREATE OR REPLACE FUNCTION pactaris.authority_sync(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;p pactaris.authority_pairs;x record;rel uuid;agr uuid;pol uuid;name text;revoked bigint;
BEGIN
 SELECT * INTO h FROM pactaris.households WHERE id=target;
 FOR p IN SELECT * FROM pactaris.authority_pairs WHERE household_id=target LOOP
  IF NOT (pactaris.authority_area(target,p.holder_id,p.subject_id,'tasks') OR pactaris.authority_area(target,p.holder_id,p.subject_id,'outcomes')) THEN
   UPDATE pactaris.assignment_policies SET state='revoked',version=version+1 WHERE household_id=target AND id=p.policy_id AND state<>'revoked' RETURNING version INTO revoked;
   IF revoked IS NOT NULL THEN INSERT INTO pactaris.assignment_policy_events VALUES(target,p.policy_id,revoked,'authorityEnded',p.holder_id,statement_timestamp()); END IF;
   UPDATE pactaris.relationships SET status='ended',ended_at=statement_timestamp(),end_reason='withdrawn',version=version+1
    WHERE household_id=target AND id=p.relationship_id AND status<>'ended';
   DELETE FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=p.holder_id AND subject_id=p.subject_id;
  END IF;
 END LOOP;
 FOR x IN SELECT a.id AS holder,b.id AS subject,a.display_name AS holder_name,b.display_name AS subject_name
   FROM pactaris.memberships a JOIN pactaris.memberships b ON b.household_id=a.household_id AND b.id<>a.id AND b.status='active'
   WHERE a.household_id=target AND a.status='active'
    AND NOT EXISTS(SELECT 1 FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=a.id AND subject_id=b.id)
    AND (pactaris.authority_area(target,a.id,b.id,'tasks') OR pactaris.authority_area(target,a.id,b.id,'outcomes')) LOOP
  name=coalesce(nullif((SELECT l.label FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.dom_id=x.holder AND l.sub_id=x.subject),''),
   left(coalesce(nullif(x.holder_name,''),'?')||' → '||coalesce(nullif(x.subject_name,''),'?'),80));
  rel=gen_random_uuid();agr=gen_random_uuid();pol=gen_random_uuid();
  INSERT INTO pactaris.relationships(household_id,id,label,status,proposer_membership_id,system) VALUES(target,rel,name,'active',x.holder,true);
  INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id,accepted,decision,decided_at)
   VALUES(target,rel,x.holder,true,'accepted',statement_timestamp()),(target,rel,x.subject,true,'accepted',statement_timestamp());
  INSERT INTO pactaris.agreements(household_id,id,relationship_id) VALUES(target,agr,rel);
  INSERT INTO pactaris.agreement_versions(household_id,agreement_id,version,terms,expires_at,created_by)
   VALUES(target,agr,1,jsonb_build_object('label',left(name,80),'scope','','hard','','soft','','signal','','aftercare','',
    'activities',jsonb_build_array('task','protocol','reward','consequence','reminder'),'validHours',720),'2999-12-31T00:00:00Z',x.holder);
  INSERT INTO pactaris.agreement_decisions(household_id,agreement_id,version,membership_id,decision,household_epoch,member_epoch,relationship_epoch,limits_version,decided_at)
   SELECT target,agr,1,m.id,'accepted',h.safety_version,m.safety_epoch,1,coalesce((SELECT version FROM pactaris.personal_limits WHERE household_id=target AND membership_id=m.id),1),statement_timestamp()
   FROM pactaris.memberships m WHERE m.household_id=target AND m.id IN (x.holder,x.subject);
  INSERT INTO pactaris.assignment_policies(household_id,id,creator_id,assignee_id,agreement_id,agreement_version,mode,state)
   VALUES(target,pol,x.holder,x.subject,agr,1,'direct','active');
  INSERT INTO pactaris.assignment_policy_events VALUES(target,pol,1,'authorityGranted',x.holder,statement_timestamp());
  INSERT INTO pactaris.authority_pairs VALUES(target,x.holder,x.subject,rel,agr,pol);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_sync(uuid) FROM PUBLIC;

-- Identical to 0007 apart from leaving out backing relationships.
CREATE OR REPLACE FUNCTION pactaris.relationship_command(target uuid,instance uuid,actor uuid,operation uuid,action text,body jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households; member pactaris.memberships; r pactaris.relationships; receipt pactaris.relationship_receipts;
 answer jsonb; listing jsonb; proposal jsonb; role jsonb; role_id uuid; relation_id uuid; participant uuid; after_id uuid; next_id uuid;
BEGIN
 IF target IS NULL OR instance IS NULL OR actor IS NULL OR operation IS NULL OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$'
  OR action IS NULL OR action NOT IN ('relationshipList','relationshipPropose','relationshipAccept','relationshipDecline','relationshipWithdraw') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.relationship.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance FOR UPDATE;
 IF NOT FOUND OR h.status='closed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
 SELECT * INTO member FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active' AND id=(body->>'membershipId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
 SELECT * INTO receipt FROM pactaris.relationship_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF receipt.household_id<>target OR receipt.actor_account_id<>actor OR receipt.actor_membership_id<>member.id OR receipt.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
  RETURN receipt.result;
 END IF;
 IF action='relationshipList' THEN
  after_id=(body->>'after')::uuid;
  SELECT coalesce(jsonb_agg(jsonb_build_object('relationshipId',v.id,'version',v.version::text,'label',v.label,'scope',v.scope,'status',v.status,'endReason',v.end_reason,
   'participants',(SELECT jsonb_agg(jsonb_build_object('membershipId',p.membership_id,'displayName',m.display_name,'decision',p.decision) ORDER BY p.membership_id)
    FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
    WHERE p.household_id=target AND p.relationship_id=v.id),
   'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',rr.membership_id,'label',d.label,'counterpartMembershipId',rr.counterpart_membership_id,'context',rr.context) ORDER BY rr.id),'[]'::jsonb)
    FROM pactaris.relationship_roles rr JOIN pactaris.dynamic_roles d ON d.household_id=rr.household_id AND d.id=rr.role_id WHERE rr.household_id=target AND rr.relationship_id=v.id)) ORDER BY v.id),'[]'::jsonb)
   INTO listing FROM (SELECT rel.* FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.proposer_membership_id IS NOT NULL AND NOT rel.system
    AND (after_id IS NULL OR rel.id>after_id) AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id)
    ORDER BY rel.id LIMIT 1) v;
  IF jsonb_array_length(listing)=1 AND EXISTS(SELECT 1 FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.proposer_membership_id IS NOT NULL AND NOT rel.system
   AND rel.id>(listing->0->>'relationshipId')::uuid AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id)) THEN
   next_id=(listing->0->>'relationshipId')::uuid; END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','listed','actorMembershipId',member.id,'relationships',listing,'nextCursor',next_id);
 END IF;
 IF action='relationshipPropose' THEN
  proposal=body->'proposal';
  IF h.status<>'active' OR jsonb_typeof(proposal)<>'object' OR char_length(proposal->>'label') NOT BETWEEN 1 AND 80 OR proposal->>'label'<>btrim(proposal->>'label')
   OR char_length(proposal->>'scope')>500 OR proposal->>'scope' IS NULL OR jsonb_typeof(proposal->'participants')<>'array'
   OR jsonb_array_length(proposal->'participants') NOT BETWEEN 2 AND 8 OR jsonb_typeof(proposal->'roles')<>'array' OR jsonb_array_length(proposal->'roles')>8 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
  IF (SELECT count(DISTINCT v::uuid) FROM jsonb_array_elements_text(proposal->'participants') v)<>jsonb_array_length(proposal->'participants') OR
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposal->'participants') v WHERE v::uuid=member.id) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
  FOR participant IN SELECT v::uuid FROM jsonb_array_elements_text(proposal->'participants') v LOOP
   IF NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=participant AND status='active') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
  END LOOP;
  relation_id=operation;
  INSERT INTO pactaris.relationships(household_id,id,label,proposer_membership_id,scope) VALUES(target,relation_id,proposal->>'label',member.id,proposal->>'scope');
  INSERT INTO pactaris.relationship_participants(household_id,relationship_id,membership_id)
   SELECT target,relation_id,v::uuid FROM jsonb_array_elements_text(proposal->'participants') v;
  FOR role IN SELECT v FROM jsonb_array_elements(proposal->'roles') v LOOP
   IF char_length(role->>'label') NOT BETWEEN 1 AND 80 OR role->>'label' IS NULL OR role->>'context' IS NULL OR char_length(role->>'context')>160 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.invalid'; END IF;
   role_id=gen_random_uuid();
   INSERT INTO pactaris.dynamic_roles(household_id,id,label) VALUES(target,role_id,role->>'label');
   INSERT INTO pactaris.relationship_roles(household_id,id,relationship_id,membership_id,role_id,counterpart_membership_id,context)
    VALUES(target,gen_random_uuid(),relation_id,(role->>'membershipId')::uuid,role_id,(role->>'counterpartMembershipId')::uuid,role->>'context');
  END LOOP;
 ELSE
  SELECT rel.* INTO r FROM pactaris.relationships rel WHERE rel.household_id=target AND rel.id=(body->>'relationshipId')::uuid AND rel.proposer_membership_id IS NOT NULL AND NOT rel.system
   AND EXISTS(SELECT 1 FROM pactaris.relationship_participants p WHERE p.household_id=target AND p.relationship_id=rel.id AND p.membership_id=member.id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.denied'; END IF;
  IF r.version::text IS DISTINCT FROM body->>'version' OR r.status='ended' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
  relation_id=r.id;
  IF action='relationshipAccept' THEN
   IF h.status<>'active' OR r.status<>'proposed' OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id AND decision='pending')
    OR EXISTS(SELECT 1 FROM pactaris.relationship_participants p JOIN pactaris.memberships m ON m.household_id=p.household_id AND m.id=p.membership_id
      WHERE p.household_id=target AND p.relationship_id=r.id AND m.status<>'active') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
   UPDATE pactaris.relationship_participants SET accepted=true,decision='accepted',decided_at=statement_timestamp() WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id;
   IF NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND decision<>'accepted') THEN
    UPDATE pactaris.relationships SET status='active' WHERE household_id=target AND id=r.id;
   END IF;
  ELSE
   IF action='relationshipDecline' AND (r.status<>'proposed' OR NOT EXISTS(SELECT 1 FROM pactaris.relationship_participants WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id AND decision='pending')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='relationship.conflict'; END IF;
   UPDATE pactaris.relationship_participants SET accepted=false,decision=CASE WHEN action='relationshipDecline' THEN 'declined' ELSE 'withdrawn' END,decided_at=statement_timestamp()
    WHERE household_id=target AND relationship_id=r.id AND membership_id=member.id;
   UPDATE pactaris.relationships SET status='ended',ended_at=statement_timestamp(),end_reason=CASE WHEN action='relationshipDecline' THEN 'declined' ELSE 'withdrawn' END WHERE household_id=target AND id=r.id;
  END IF;
 END IF;
 -- The receipt confirms a past command, never current relationship state or consent.
 answer=jsonb_build_object('householdId',target,'operationId',operation,'status','applied','actorMembershipId',member.id,'relationshipId',relation_id);
 INSERT INTO pactaris.relationship_receipts VALUES(operation,target,member.id,actor,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'relationship.'||action,relation_id,jsonb_build_object('operationId',operation));
 INSERT INTO pactaris.relationship_outbox(operation_id,household_id,event_key) VALUES(operation,target,'relationship.'||action);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.relationship_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Progress over the last 14 days (oldest first, ending today in the household time zone) and a household board. Read-only.
-- Shown for yourself, for subs you hold authority over, and, when the household
-- owner made subs visible and you are part of a Dom link, for every sub whose
-- links are not marked private.
CREATE FUNCTION pactaris.authority_progress_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;involved boolean;today date;people jsonb;
BEGIN
 IF action IS DISTINCT FROM 'progressList' OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 involved=EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND m.id IN (dom_id,sub_id));
 today=(statement_timestamp() AT TIME ZONE h.time_zone)::date;
 WITH shown AS (
  SELECT o.id,o.display_name,o.sub_rank FROM pactaris.memberships o
  WHERE o.household_id=target AND o.status='active'
   AND EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.sub_id=o.id)
   AND (o.id=m.id OR pactaris.authority_area(target,m.id,o.id,'tasks') OR pactaris.authority_area(target,m.id,o.id,'outcomes')
    OR (h.subs_visible AND involved AND NOT EXISTS(SELECT 1 FROM pactaris.authority_links l WHERE l.household_id=target AND l.state='active' AND l.sub_id=o.id AND l.private)))
  ORDER BY o.sub_rank NULLS LAST,o.display_name,o.id LIMIT 50
 ),days AS (SELECT (today-n)::date AS day FROM generate_series(0,13) n),
 approvals AS (
  SELECT t.assignee_id AS person,t.id AS task,min(e.at) AS approved_at FROM pactaris.partner_events e
   JOIN pactaris.partner_tasks t ON t.household_id=e.household_id AND t.id=e.task_id
   WHERE e.household_id=target AND e.action='partnerApprove' AND e.at>=statement_timestamp()-interval '16 days' AND t.assignee_id IN (SELECT id FROM shown)
   GROUP BY t.assignee_id,t.id
 ),done AS (
  SELECT a.person,(a.approved_at AT TIME ZONE h.time_zone)::date AS day,count(*) AS tasks FROM approvals a GROUP BY 1,2
 ),earned AS (
  SELECT z.person,z.day,sum(z.points) AS points FROM (
   SELECT a.person,(a.approved_at AT TIME ZONE h.time_zone)::date AS day,g.points FROM approvals a
    JOIN pactaris.task_points g ON g.household_id=target AND g.task_id=a.task AND g.recipient=a.person
    WHERE NOT EXISTS(SELECT 1 FROM pactaris.task_point_reversals x WHERE x.household_id=target AND x.task_id=a.task)
   UNION ALL
   SELECT p.recipient_id,(p.created_at AT TIME ZONE h.time_zone)::date,p.points FROM pactaris.point_adjustments p
    WHERE p.household_id=target AND p.created_at>=statement_timestamp()-interval '16 days' AND p.recipient_id IN (SELECT id FROM shown)
  ) z GROUP BY 1,2
 ),habit AS (
  SELECT x.subject_id AS person,r.period_start+CASE WHEN x.period='weekly' THEN 6 ELSE 0 END AS day,
   count(*) FILTER (WHERE r.result='reached') AS reached,count(*) FILTER (WHERE r.result='missed') AS missed
   FROM pactaris.authority_habit_results r JOIN pactaris.authority_habits x ON x.household_id=r.household_id AND x.id=r.habit_id
   WHERE r.household_id=target AND r.period_start>=today-20 AND x.subject_id IN (SELECT id FROM shown) GROUP BY 1,2
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',s.id,'name',s.display_name,'rank',s.sub_rank,'self',s.id=m.id,
   'doms',(SELECT coalesce(jsonb_agg(d.display_name ORDER BY d.display_name,d.id),'[]'::jsonb) FROM pactaris.authority_links l
     JOIN pactaris.memberships d ON d.household_id=l.household_id AND d.id=l.dom_id WHERE l.household_id=target AND l.state='active' AND l.sub_id=s.id),
   'balance',pactaris.authority_points(target,s.id)::text,
   'openTasks',(SELECT count(*) FROM pactaris.partner_tasks t WHERE t.household_id=target AND t.assignee_id=s.id AND t.state NOT IN ('done','declined','cancelled')),
   'tasks',(SELECT jsonb_agg(coalesce(dn.tasks,0) ORDER BY dd.day) FROM days dd LEFT JOIN done dn ON dn.person=s.id AND dn.day=dd.day),
   'points',(SELECT jsonb_agg(coalesce(er.points,0) ORDER BY dd.day) FROM days dd LEFT JOIN earned er ON er.person=s.id AND er.day=dd.day),
   'reached',(SELECT jsonb_agg(coalesce(hb.reached,0) ORDER BY dd.day) FROM days dd LEFT JOIN habit hb ON hb.person=s.id AND hb.day=dd.day),
   'missed',(SELECT jsonb_agg(coalesce(hb.missed,0) ORDER BY dd.day) FROM days dd LEFT JOIN habit hb ON hb.person=s.id AND hb.day=dd.day))
  ORDER BY s.sub_rank NULLS LAST,s.display_name,s.id),'[]'::jsonb) INTO people FROM shown s;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed','today',today::text,'subsVisible',h.subs_visible,'people',people);
END $$;
REVOKE ALL ON FUNCTION pactaris.authority_progress_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
